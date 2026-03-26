/**
 * `ao start` and `ao stop` commands — unified orchestrator startup.
 *
 * Supports two modes:
 *   1. `ao start [project]` — start from existing config
 *   2. `ao start <url>` — clone repo, auto-generate config, then start
 *
 * The orchestrator prompt is passed to the agent via --append-system-prompt
 * (or equivalent flag) at launch time — no file writing required.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { cwd } from "node:process";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import React from "react";
import { render, Box, Text } from "ink";
import {
  loadConfig,
  generateOrchestratorPrompt,
  generateSessionPrefix,
  findConfigFile,
  isRepoUrl,
  parseRepoUrl,
  resolveCloneTarget,
  isRepoAlreadyCloned,
  generateConfigFromUrl,
  configToYaml,
  normalizeOrchestratorSessionStrategy,
  ConfigNotFoundError,
  type OrchestratorConfig,
  type ProjectConfig,
  type ParsedRepoUrl,
  type Session,
  type SessionStatus,
  type ActivityState,
} from "@composio/ao-core";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { exec, execSilent, git } from "../lib/shell.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { ensureLifecycleWorker, stopLifecycleWorker } from "../lib/lifecycle-service.js";
import { preflight } from "../lib/preflight.js";
import { register, unregister, isAlreadyRunning, getRunning, waitForExit } from "../lib/running-state.js";
import { isHumanCaller } from "../lib/caller-context.js";
import { detectEnvironment } from "../lib/detect-env.js";
import { detectAgentRuntime } from "../lib/detect-agent.js";
import { detectDefaultBranch } from "../lib/git-utils.js";
import {
  detectProjectType,
  generateRulesFromTemplates,
  formatProjectTypeForDisplay,
} from "../lib/project-detection.js";

// =============================================================================
// INK TERMINAL RENDERER
// =============================================================================

function getStatusColor(status: SessionStatus, activity: ActivityState | null, stuckMs: number | null): "green" | "yellow" | "red" | "gray" {
  if (status === "stuck" || activity === "blocked") {
    if (stuckMs !== null && stuckMs > 15 * 60 * 1000) return "red";
    return "yellow";
  }
  if (status === "working" || activity === "active") return "green";
  if (status === "done" || status === "merged" || activity === "exited") return "gray";
  return "gray";
}

function formatStuckTime(stuckMs: number | null): string {
  if (stuckMs === null) return "";
  const mins = Math.floor(stuckMs / 60000);
  if (mins < 1) return "";
  if (mins < 60) return `STUCK ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `STUCK ${hrs}h${remainMins}m`;
}

interface AgentStatusLineProps {
  session: Session;
  now: number;
}

function AgentStatusLine({ session, now }: AgentStatusLineProps) {
  const stuckMs = session.status === "stuck" && session.lastActivityAt
    ? now - session.lastActivityAt.getTime()
    : null;
  const color = getStatusColor(session.status, session.activity, stuckMs);
  const stuckLabel = formatStuckTime(stuckMs);

  const summary = session.agentInfo?.summary || session.metadata?.["summary"] || "";

  return (
    <Box>
      <Box width={20}>
        <Text bold color="cyan">{session.id}</Text>
      </Box>
      <Box width={12}>
        {stuckLabel ? (
          <Text color={color}>{stuckLabel}</Text>
        ) : (
          <Text color={color}>{session.status}</Text>
        )}
      </Box>
      <Text dimColor>"{summary.slice(0, 40)}{summary.length > 40 ? "..." : ""}"</Text>
    </Box>
  );
}

interface TerminalRendererProps {
  sessions: Session[];
}

function TerminalRenderer({ sessions }: TerminalRendererProps) {
  const [now, setNow] = React.useState(Date.now());

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const activeSessions = sessions.filter(s =>
    !["done", "merged", "killed", "terminated", "cleanup"].includes(s.status)
  );

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="magenta">Agent Orchestrator</Text>
        <Text dimColor> — {activeSessions.length} active sessions</Text>
      </Box>
      {activeSessions.length === 0 ? (
        <Text dimColor>No active sessions. Run: ao spawn {"<issue>"}</Text>
      ) : (
        activeSessions.map(session => (
          <AgentStatusLine key={session.id} session={session} now={now} />
        ))
      )}
      <Box marginTop={1}>
        <Text dimColor>Press Ctrl+C to stop</Text>
      </Box>
    </Box>
  );
}

async function startTerminalRenderer(config: OrchestratorConfig): Promise<() => void> {
  const sm = await getSessionManager(config);
  let sessions: Session[] = [];

  const { rerender, unmount } = render(<TerminalRenderer sessions={sessions} />);

  // Poll for session updates every 5 seconds
  const interval = setInterval(async () => {
    try {
      sessions = await sm.list();
      rerender(<TerminalRenderer sessions={sessions} />);
    } catch (err) {
      // Ignore polling errors
    }
  }, 5000);

  // Initial fetch
  try {
    sessions = await sm.list();
    rerender(<TerminalRenderer sessions={sessions} />);
  } catch {
    // Ignore initial errors
  }

  return () => {
    clearInterval(interval);
    unmount();
  };
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Resolve project from config.
 */
function resolveProject(
  config: OrchestratorConfig,
  projectArg?: string,
): { projectId: string; project: ProjectConfig } {
  const projectIds = Object.keys(config.projects);

  if (projectIds.length === 0) {
    throw new Error("No projects configured. Add a project to agent-orchestrator.yaml.");
  }

  if (projectArg) {
    const project = config.projects[projectArg];
    if (!project) {
      throw new Error(
        `Project "${projectArg}" not found. Available projects:\n  ${projectIds.join(", ")}`,
      );
    }
    return { projectId: projectArg, project };
  }

  if (projectIds.length === 1) {
    const projectId = projectIds[0];
    return { projectId, project: config.projects[projectId] };
  }

  const currentDir = resolve(cwd());
  for (const [id, proj] of Object.entries(config.projects)) {
    if (resolve(proj.path) === currentDir) {
      return { projectId: id, project: proj };
    }
  }

  throw new Error(
    `Multiple projects configured. Specify which one to start:\n  ${projectIds.map((id) => `ao start ${id}`).join("\n  ")}`,
  );
}

function resolveProjectByRepo(
  config: OrchestratorConfig,
  parsed: ParsedRepoUrl,
): { projectId: string; project: ProjectConfig } {
  const projectIds = Object.keys(config.projects);

  for (const id of projectIds) {
    const project = config.projects[id];
    if (project.repo === parsed.ownerRepo) {
      return { projectId: id, project };
    }
  }

  return resolveProject(config);
}

async function cloneRepo(parsed: ParsedRepoUrl, targetDir: string, cwd: string): Promise<void> {
  if (parsed.host === "github.com") {
    const ghAvailable = (await execSilent("gh", ["auth", "status"])) !== null;
    if (ghAvailable) {
      try {
        await exec("gh", ["repo", "clone", parsed.ownerRepo, targetDir, "--", "--depth", "1"], {
          cwd,
        });
        return;
      } catch {
        // Fall through
      }
    }
  }

  const sshUrl = `git@${parsed.host}:${parsed.ownerRepo}.git`;
  try {
    await exec("git", ["clone", "--depth", "1", sshUrl, targetDir], { cwd });
    return;
  } catch {
    // Fall through
  }

  await exec("git", ["clone", "--depth", "1", parsed.cloneUrl, targetDir], { cwd });
}

async function handleUrlStart(
  url: string,
): Promise<{ config: OrchestratorConfig; parsed: ParsedRepoUrl; autoGenerated: boolean }> {
  const spinner = ora();

  spinner.start("Parsing repository URL");
  const parsed = parseRepoUrl(url);
  spinner.succeed(`Repository: ${chalk.cyan(parsed.ownerRepo)} (${parsed.host})`);

  const cwd = process.cwd();
  const targetDir = resolveCloneTarget(parsed, cwd);
  const alreadyCloned = isRepoAlreadyCloned(targetDir, parsed.cloneUrl);

  if (alreadyCloned) {
    console.log(chalk.green(`  Reusing existing clone at ${targetDir}`));
  } else {
    spinner.start(`Cloning ${parsed.ownerRepo}`);
    try {
      await cloneRepo(parsed, targetDir, cwd);
      spinner.succeed(`Cloned to ${targetDir}`);
    } catch (err) {
      spinner.fail("Clone failed");
      throw new Error(
        `Failed to clone ${parsed.ownerRepo}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  const configPath = resolve(targetDir, "agent-orchestrator.yaml");
  const configPathAlt = resolve(targetDir, "agent-orchestrator.yml");

  if (existsSync(configPath)) {
    console.log(chalk.green(`  Using existing config: ${configPath}`));
    return { config: loadConfig(configPath), parsed, autoGenerated: false };
  }

  if (existsSync(configPathAlt)) {
    console.log(chalk.green(`  Using existing config: ${configPathAlt}`));
    return { config: loadConfig(configPathAlt), parsed, autoGenerated: false };
  }

  spinner.start("Generating config");
  const rawConfig = generateConfigFromUrl({
    parsed,
    repoPath: targetDir,
    port: 3000,
  });

  const yamlContent = configToYaml(rawConfig);
  writeFileSync(configPath, yamlContent);
  spinner.succeed(`Config generated: ${configPath}`);

  return { config: loadConfig(configPath), parsed, autoGenerated: true };
}

async function autoCreateConfig(workingDir: string): Promise<OrchestratorConfig> {
  console.log(chalk.bold.cyan("\n  Agent Orchestrator — First Run Setup\n"));
  console.log(chalk.dim("  Detecting project and generating config...\n"));

  const env = await detectEnvironment(workingDir);
  const projectType = detectProjectType(workingDir);

  if (env.isGitRepo) {
    console.log(chalk.green("  ✓ Git repository detected"));
    if (env.ownerRepo) {
      console.log(chalk.dim(`    Remote: ${env.ownerRepo}`));
    }
    if (env.currentBranch) {
      console.log(chalk.dim(`    Branch: ${env.currentBranch}`));
    }
  }

  if (projectType.languages.length > 0 || projectType.frameworks.length > 0) {
    console.log(chalk.green("  ✓ Project type detected"));
    const formattedType = formatProjectTypeForDisplay(projectType);
    formattedType.split("\n").forEach((line) => {
      console.log(chalk.dim(`    ${line}`));
    });
  }

  console.log();

  const agentRules = generateRulesFromTemplates(projectType);

  const projectId = env.isGitRepo ? basename(workingDir) : "my-project";
  const repo = env.ownerRepo || "owner/repo";
  const path = env.isGitRepo ? workingDir : `~/${projectId}`;
  const defaultBranch = env.defaultBranch || "main";

  const agent = await detectAgentRuntime();
  console.log(chalk.green(`  ✓ Agent runtime: ${agent}`));

  const config: Record<string, unknown> = {
    defaults: {
      runtime: "tmux",
      agent,
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {
      [projectId]: {
        name: projectId,
        sessionPrefix: generateSessionPrefix(projectId),
        repo,
        path,
        defaultBranch,
        ...(agentRules ? { agentRules } : {}),
      },
    },
  };

  const outputPath = resolve(workingDir, "agent-orchestrator.yaml");
  if (existsSync(outputPath)) {
    console.log(chalk.yellow(`⚠ Config already exists: ${outputPath}`));
    console.log(chalk.dim("  Use 'ao start' to start with the existing config.\n"));
    return loadConfig(outputPath);
  }
  const yamlContent = yamlStringify(config, { indent: 2 });
  writeFileSync(outputPath, yamlContent);

  console.log(chalk.green(`✓ Config created: ${outputPath}\n`));

  if (repo === "owner/repo") {
    console.log(chalk.yellow("⚠ Could not detect GitHub remote."));
    console.log(chalk.dim("  Update the 'repo' field in the config before spawning agents.\n"));
  }

  if (!env.hasTmux) {
    console.log(chalk.yellow("⚠ tmux not found — install with: brew install tmux"));
  }
  if (!env.ghAuthed && env.hasGh) {
    console.log(chalk.yellow("⚠ GitHub CLI not authenticated — run: gh auth login"));
  }

  return loadConfig(outputPath);
}

async function addProjectToConfig(
  config: OrchestratorConfig,
  projectPath: string,
): Promise<string> {
  const resolvedPath = resolve(projectPath.replace(/^~/, process.env["HOME"] || ""));
  let projectId = basename(resolvedPath);

  if (config.projects[projectId]) {
    let i = 2;
    while (config.projects[`${projectId}-${i}`]) i++;
    const newId = `${projectId}-${i}`;
    console.log(chalk.yellow(`  ⚠ Project "${projectId}" already exists — using "${newId}" instead.`));
    projectId = newId;
  }

  console.log(chalk.dim(`\n  Adding project "${projectId}"...\n`));

  const isGitRepo = (await git(["rev-parse", "--git-dir"], resolvedPath)) !== null;
  if (!isGitRepo) {
    throw new Error(`"${resolvedPath}" is not a git repository.`);
  }

  let ownerRepo: string | null = null;
  const gitRemote = await git(["remote", "get-url", "origin"], resolvedPath);
  if (gitRemote) {
    const match = gitRemote.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
    if (match) ownerRepo = match[1];
  }

  const defaultBranch = await detectDefaultBranch(resolvedPath, ownerRepo);

  let prefix = generateSessionPrefix(projectId);
  const existingPrefixes = new Set(
    Object.values(config.projects).map(
      (p) => p.sessionPrefix || generateSessionPrefix(basename(p.path)),
    ),
  );
  if (existingPrefixes.has(prefix)) {
    let i = 2;
    while (existingPrefixes.has(`${prefix}${i}`)) i++;
    prefix = `${prefix}${i}`;
  }

  const projectType = detectProjectType(resolvedPath);
  const agentRules = generateRulesFromTemplates(projectType);

  console.log(chalk.green(`  ✓ Git repository`));
  if (ownerRepo) {
    console.log(chalk.dim(`    Remote: ${ownerRepo}`));
  }
  console.log(chalk.dim(`    Default branch: ${defaultBranch}`));
  console.log(chalk.dim(`    Session prefix: ${prefix}`));

  if (projectType.languages.length > 0 || projectType.frameworks.length > 0) {
    console.log(chalk.green("  ✓ Project type detected"));
    const formattedType = formatProjectTypeForDisplay(projectType);
    formattedType.split("\n").forEach((line) => {
      console.log(chalk.dim(`    ${line}`));
    });
  }

  const rawYaml = readFileSync(config.configPath, "utf-8");
  const rawConfig = yamlParse(rawYaml);
  if (!rawConfig.projects) rawConfig.projects = {};

  rawConfig.projects[projectId] = {
    name: projectId,
    repo: ownerRepo || "owner/repo",
    path: resolvedPath,
    defaultBranch,
    sessionPrefix: prefix,
    ...(agentRules ? { agentRules } : {}),
  };

  writeFileSync(config.configPath, yamlStringify(rawConfig, { indent: 2 }));
  console.log(chalk.green(`\n✓ Added "${projectId}" to ${config.configPath}\n`));

  if (!ownerRepo) {
    console.log(chalk.yellow("⚠ Could not detect GitHub remote."));
    console.log(chalk.dim("  Update the 'repo' field in the config before spawning agents.\n"));
  }

  return projectId;
}

export async function createConfigOnly(): Promise<void> {
  await autoCreateConfig(cwd());
}

/**
 * Shared startup logic: launch orchestrator session + terminal renderer.
 */
async function runStartup(
  config: OrchestratorConfig,
  projectId: string,
  project: ProjectConfig,
  opts?: { orchestrator?: boolean },
): Promise<void> {
  const sessionId = `${project.sessionPrefix}-orchestrator`;
  const orchestratorSessionStrategy = normalizeOrchestratorSessionStrategy(
    project.orchestratorSessionStrategy,
  );

  console.log(chalk.bold(`\nStarting orchestrator for ${chalk.cyan(project.name)}\n`));

  const spinner = ora();
  let reused = false;

  // Start lifecycle worker
  let lifecycleStatus: Awaited<ReturnType<typeof ensureLifecycleWorker>> | null = null;
  try {
    spinner.start("Starting lifecycle worker");
    lifecycleStatus = await ensureLifecycleWorker(config, projectId);
    spinner.succeed(
      lifecycleStatus.started
        ? `Lifecycle worker started${lifecycleStatus.pid ? ` (PID ${lifecycleStatus.pid})` : ""}`
        : `Lifecycle worker already running${lifecycleStatus.pid ? ` (PID ${lifecycleStatus.pid})` : ""}`,
    );
  } catch (err) {
    spinner.fail("Lifecycle worker failed to start");
    throw new Error(
      `Failed to start lifecycle worker: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // Create orchestrator session
  let tmuxTarget = sessionId;
  if (opts?.orchestrator !== false) {
    const sm = await getSessionManager(config);

    try {
      spinner.start("Creating orchestrator session");
      const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
      const session = await sm.spawnOrchestrator({ projectId, systemPrompt });
      if (session.runtimeHandle?.id) {
        tmuxTarget = session.runtimeHandle.id;
      }
      reused =
        orchestratorSessionStrategy === "reuse" &&
        session.metadata?.["orchestratorSessionReused"] === "true";
      spinner.succeed(reused ? "Orchestrator session reused" : "Orchestrator session created");
    } catch (err) {
      spinner.fail("Orchestrator setup failed");
      throw new Error(
        `Failed to setup orchestrator: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // Print summary
  console.log(chalk.bold.green("\n✓ Startup complete\n"));

  if (lifecycleStatus) {
    const lifecycleLabel = lifecycleStatus.started ? "started" : "already running";
    const lifecycleTarget = lifecycleStatus.pid
      ? `${lifecycleLabel} (PID ${lifecycleStatus.pid})`
      : lifecycleLabel;
    console.log(chalk.cyan("Lifecycle:"), lifecycleTarget);
  }

  if (opts?.orchestrator !== false && !reused) {
    console.log(chalk.cyan("Orchestrator:"), `tmux attach -t ${tmuxTarget}`);
  } else if (reused) {
    console.log(chalk.cyan("Orchestrator:"), `reused existing session (${sessionId})`);
  }

  console.log(chalk.dim(`Config: ${config.configPath}`));

  // Show next step hint
  const projectIds = Object.keys(config.projects);
  if (projectIds.length > 0) {
    console.log(chalk.bold("\nNext step:\n"));
    console.log(`  Spawn an agent session:`);
    console.log(chalk.cyan(`     ao spawn <issue-number>\n`));
  }

  // Start terminal renderer
  console.log(chalk.dim("Starting terminal status monitor...\n"));
  const stopRenderer = await startTerminalRenderer(config);

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log(chalk.dim("\nStopping..."));
    stopRenderer();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerStart(program: Command): void {
  program
    .command("start [project]")
    .description(
      "Start orchestrator agent (auto-creates config on first run, adds projects by path/URL)",
    )
    .option("--no-orchestrator", "Skip starting the orchestrator agent")
    .action(
      async (
        projectArg?: string,
        opts?: {
          orchestrator?: boolean;
        },
      ) => {
        try {
          let config: OrchestratorConfig;
          let projectId: string;
          let project: ProjectConfig;

          if (projectArg && isRepoUrl(projectArg)) {
            console.log(chalk.bold.cyan("\n  Agent Orchestrator — Quick Start\n"));
            const result = await handleUrlStart(projectArg);
            config = result.config;
            ({ projectId, project } = resolveProjectByRepo(config, result.parsed));
          } else if (projectArg && isLocalPath(projectArg)) {
            const resolvedPath = resolve(projectArg.replace(/^~/, process.env["HOME"] || ""));

            let configPath: string | undefined;
            try {
              configPath = findConfigFile() ?? undefined;
            } catch {
              // No config found
            }

            if (!configPath) {
              config = await autoCreateConfig(cwd());
              if (resolve(cwd()) !== resolvedPath) {
                const addedId = await addProjectToConfig(config, resolvedPath);
                config = loadConfig(config.configPath);
                projectId = addedId;
                project = config.projects[projectId];
              } else {
                ({ projectId, project } = resolveProject(config));
              }
            } else {
              config = loadConfig(configPath);

              const existingEntry = Object.entries(config.projects).find(
                ([, p]) => resolve(p.path.replace(/^~/, process.env["HOME"] || "")) === resolvedPath,
              );

              if (existingEntry) {
                projectId = existingEntry[0];
                project = existingEntry[1];
              } else {
                const addedId = await addProjectToConfig(config, resolvedPath);
                config = loadConfig(config.configPath);
                projectId = addedId;
                project = config.projects[projectId];
              }
            }
          } else {
            let loadedConfig: OrchestratorConfig | null = null;
            try {
              loadedConfig = loadConfig();
            } catch (err) {
              if (err instanceof ConfigNotFoundError) {
                loadedConfig = await autoCreateConfig(cwd());
              } else {
                throw err;
              }
            }
            config = loadedConfig;
            ({ projectId, project } = resolveProject(config, projectArg));
          }

          // Already-running detection
          const running = await isAlreadyRunning();
          if (running) {
            if (isHumanCaller()) {
              console.log(chalk.cyan(`\nℹ AO is already running.`));
              console.log(`  PID: ${running.pid} | Up since: ${running.startedAt}`);
              console.log(`  Projects: ${running.projects.join(", ")}\n`);

              const { createInterface } = await import("node:readline/promises");
              const rl = createInterface({ input: process.stdin, output: process.stdout });
              console.log("  1. Keep current");
              console.log("  2. Start new orchestrator on this project");
              console.log("  3. Override — restart everything");
              console.log("  4. Quit\n");
              const choice = await rl.question("  Choice [1-4]: ");
              rl.close();

              if (choice.trim() === "1") {
                process.exit(0);
              } else if (choice.trim() === "2") {
                const rawYaml = readFileSync(config.configPath, "utf-8");
                const rawConfig = yamlParse(rawYaml);

                const existingPrefixes = new Set(
                  Object.values(rawConfig.projects as Record<string, Record<string, unknown>>).map(
                    (p) => p.sessionPrefix as string,
                  ).filter(Boolean),
                );

                let newId: string;
                let newPrefix: string;
                do {
                  const suffix = Math.random().toString(36).slice(2, 6);
                  newId = `${projectId}-${suffix}`;
                  newPrefix = generateSessionPrefix(newId);
                } while (rawConfig.projects[newId] || existingPrefixes.has(newPrefix));

                rawConfig.projects[newId] = {
                  ...rawConfig.projects[projectId],
                  sessionPrefix: newPrefix,
                };
                writeFileSync(config.configPath, yamlStringify(rawConfig, { indent: 2 }));
                console.log(chalk.green(`\n✓ New orchestrator "${newId}" added to config\n`));
                config = loadConfig(config.configPath);
                projectId = newId;
                project = config.projects[newId];
              } else if (choice.trim() === "3") {
                try { process.kill(running.pid, "SIGTERM"); } catch { /* already dead */ }
                if (!(await waitForExit(running.pid, 5000))) {
                  console.log(chalk.yellow("  Process didn't exit cleanly, sending SIGKILL..."));
                  try { process.kill(running.pid, "SIGKILL"); } catch { /* already dead */ }
                }
                await unregister();
                console.log(chalk.yellow("\n  Stopped existing instance. Restarting...\n"));
              } else {
                process.exit(0);
              }
            } else {
              console.log(`AO is already running.`);
              console.log(`PID: ${running.pid}`);
              console.log(`Projects: ${running.projects.join(", ")}`);
              console.log(`To restart: ao stop && ao start`);
              process.exit(0);
            }
          }

          await runStartup(config, projectId, project, opts);

          // Register in running.json
          await register({
            pid: process.pid,
            configPath: config.configPath,
            port: 0, // No dashboard port
            startedAt: new Date().toISOString(),
            projects: Object.keys(config.projects),
          });
        } catch (err) {
          if (err instanceof Error) {
            console.error(chalk.red("\nError:"), err.message);
          } else {
            console.error(chalk.red("\nError:"), String(err));
          }
          process.exit(1);
        }
      },
    );
}

function isLocalPath(arg: string): boolean {
  return arg.startsWith("/") || arg.startsWith("~") || arg.startsWith("./") || arg.startsWith("..");
}

export function registerStop(program: Command): void {
  program
    .command("stop [project]")
    .description("Stop orchestrator agent")
    .option("--keep-session", "Keep mapped OpenCode session after stopping")
    .option("--purge-session", "Delete mapped OpenCode session when stopping")
    .option("--all", "Stop all running AO instances")
    .action(
      async (
        projectArg?: string,
        opts: { keepSession?: boolean; purgeSession?: boolean; all?: boolean } = {},
      ) => {
        try {
          const running = await getRunning();

          if (opts.all) {
            if (running) {
              try {
                process.kill(running.pid, "SIGTERM");
              } catch {
                // Already dead
              }
              await unregister();
              console.log(chalk.green(`\n✓ Stopped AO`));
              console.log(chalk.dim(`  Projects: ${running.projects.join(", ")}\n`));
            } else {
              console.log(chalk.yellow("No running AO instance found."));
            }
            return;
          }

          const config = loadConfig();
          const { projectId: _projectId, project } = resolveProject(config, projectArg);
          const sessionId = `${project.sessionPrefix}-orchestrator`;

          console.log(chalk.bold(`\nStopping orchestrator for ${chalk.cyan(project.name)}\n`));

          const sm = await getSessionManager(config);
          const existing = await sm.get(sessionId);

          if (existing) {
            const spinner = ora("Stopping orchestrator session").start();
            const purgeOpenCode = opts.purgeSession === true ? true : opts.keepSession !== true;
            await sm.kill(sessionId, { purgeOpenCode });
            spinner.succeed("Orchestrator session stopped");
          } else {
            console.log(chalk.yellow(`Orchestrator session "${sessionId}" is not running`));
          }

          const lifecycleStopped = await stopLifecycleWorker(config, _projectId);
          if (lifecycleStopped) {
            console.log(chalk.green("Lifecycle worker stopped"));
          } else {
            console.log(chalk.yellow("Lifecycle worker not running"));
          }

          if (running) {
            try {
              process.kill(running.pid, "SIGTERM");
            } catch {
              // Already dead
            }
            await unregister();
          }

          console.log(chalk.bold.green("\n✓ Orchestrator stopped\n"));
          console.log(
            chalk.dim(`  Uptime: since ${running?.startedAt ?? "unknown"}`),
          );
          console.log(
            chalk.dim(`  Projects: ${Object.keys(config.projects).join(", ")}\n`),
          );
        } catch (err) {
          if (err instanceof Error) {
            console.error(chalk.red("\nError:"), err.message);
          } else {
            console.error(chalk.red("\nError:"), String(err));
          }
          process.exit(1);
        }
      },
    );
}
