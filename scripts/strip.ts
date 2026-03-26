#!/usr/bin/env bun
/**
 * Strip script — surgery to remove web dashboard and Composio SDK dependencies.
 * Run with: bun scripts/strip.ts
 */

import { existsSync, rmSync, readFileSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { join, relative } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");

// Directories to delete
const DIRS_TO_DELETE = [
  "packages/web",
  "packages/plugins/terminal-web",
  "packages/plugins/notifier-composio",
];

// Fields to remove from OrchestratorConfig
const FIELDS_TO_REMOVE = ["port", "terminalPort", "directTerminalPort"];

console.log("🔪 Stripping agent-orchestrator to core...\n");

// 1. Delete directories
console.log("1. Deleting directories...");
for (const dir of DIRS_TO_DELETE) {
  const fullPath = join(ROOT, dir);
  if (existsSync(fullPath)) {
    rmSync(fullPath, { recursive: true, force: true });
    console.log(`   ✓ Deleted ${dir}`);
  } else {
    console.log(`   ✓ Already gone: ${dir}`);
  }
}

// 2. Update pnpm-workspace.yaml (uses globs, no explicit packages to remove)
console.log("\n2. Checking pnpm-workspace.yaml...");
// The workspace uses globs like "packages/*" and "packages/plugins/*"
// so deleted dirs are automatically excluded. No changes needed.
console.log("   ✓ Uses globs — no explicit package refs to remove");

// 3. Remove fields from OrchestratorConfig in types.ts
console.log("\n3. Removing port fields from OrchestratorConfig...");
const typesPath = join(ROOT, "packages/core/src/types.ts");
let typesContent = readFileSync(typesPath, "utf-8");

for (const field of FIELDS_TO_REMOVE) {
  // Match the field and its JSDoc comment (lines starting with /** up to the field)
  const fieldPattern = new RegExp(
    `(\\/\\*\\*[\\s\\S]*?\\*\\/\\n\\s*${field}\\?: number;\\n)|` +
    `(\\s*${field}\\?: number;\\n)`,
    "g"
  );
  if (fieldPattern.test(typesContent)) {
    typesContent = typesContent.replace(fieldPattern, "");
    console.log(`   ✓ Removed ${field}`);
  } else {
    console.log(`   ✓ Already gone: ${field}`);
  }
}
writeFileSync(typesPath, typesContent);

// 4. Remove @composio/* imports (excluding @composio/ao)
console.log("\n4. Removing @composio/* imports (keeping @composio/ao)...");
let importRemovalCount = 0;

function processFile(filePath: string): void {
  let content = readFileSync(filePath, "utf-8");
  const original = content;

  // Match import statements that import from @composio/ but NOT @composio/ao
  // Handles both single and multi-line imports
  const importPattern = /^import\s+(?:type\s+)?[^;]+from\s+["']@composio\/(?!ao)["'];?\s*$\n?/gm;

  // Also match dynamic imports
  const dynamicImportPattern = /import\(["']@composio\/(?!ao)["']\)/g;

  // Remove static imports
  content = content.replace(importPattern, "");

  // Comment out lines with dynamic imports (can't just remove, might break code flow)
  if (dynamicImportPattern.test(content)) {
    content = content.replace(
      /(.*import\(["']@composio\/(?!ao)["']\).*)/g,
      "// STRIPPED: $1"
    );
  }

  if (content !== original) {
    writeFileSync(filePath, content);
    const relPath = relative(ROOT, filePath);
    console.log(`   ✓ Cleaned ${relPath}`);
    importRemovalCount++;
  }
}

function walkDir(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules and deleted dirs
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (DIRS_TO_DELETE.some(d => fullPath.includes(d.replace("packages/", "")))) continue;
      walkDir(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      processFile(fullPath);
    }
  }
}

// Walk packages directory
const packagesDir = join(ROOT, "packages");
if (existsSync(packagesDir)) {
  walkDir(packagesDir);
}
console.log(`   ✓ Cleaned ${importRemovalCount} files`);

// 5. Remove integration tests for deleted plugins
console.log("\n5. Removing integration tests for deleted plugins...");
const testsToRemove = [
  "packages/integration-tests/src/notifier-composio.integration.test.ts",
];
for (const testFile of testsToRemove) {
  const fullPath = join(ROOT, testFile);
  if (existsSync(fullPath)) {
    rmSync(fullPath, { force: true });
    console.log(`   ✓ Deleted ${testFile}`);
  }
}

// 6. Remove dependencies from package.json files
console.log("\n6. Removing deleted packages from package.json files...");
const pkgJsonPaths = [
  "packages/cli/package.json",
  "packages/core/package.json",
];

for (const pkgJsonPath of pkgJsonPaths) {
  const fullPath = join(ROOT, pkgJsonPath);
  if (!existsSync(fullPath)) continue;

  let content = readFileSync(fullPath, "utf-8");
  const original = content;

  // Remove references to deleted packages
  const pkgsToRemove = [
    "@composio/ao-plugin-notifier-composio",
    "@composio/ao-web",
    "@composio/ao-plugin-terminal-web",
  ];

  for (const pkg of pkgsToRemove) {
    // Escape forward slash for regex
    const escapedPkg = pkg.replace(/\//g, "\\\\/");
    // Remove from dependencies - match entire line including trailing comma and newline
    const depPattern = new RegExp(`"${escapedPkg}"\\s*:\\s*"[^"]*"\\s*,?\\s*\\n`, "g");
    content = content.replace(depPattern, "");
  }

  if (content !== original) {
    writeFileSync(fullPath, content);
    console.log(`   ✓ Cleaned ${pkgJsonPath}`);
  }
}

// 7. Run pnpm install && pnpm build
console.log("\n7. Running pnpm install && pnpm build...\n");

try {
  await $`pnpm install`.cwd(ROOT);
  console.log("\n✓ pnpm install complete\n");

  await $`pnpm build`.cwd(ROOT);
  console.log("\n✓ pnpm build complete\n");
} catch (err) {
  console.error("Build failed:", err);
  process.exit(1);
}

// 8. Rename start.ts to start.tsx for JSX support
console.log("\n8. Renaming start.ts to start.tsx...");
const startTsPath = join(ROOT, "packages/cli/src/commands/start.ts");
const startTsxPath = join(ROOT, "packages/cli/src/commands/start.tsx");
if (existsSync(startTsPath)) {
  renameSync(startTsPath, startTsxPath);
  console.log("   ✓ Renamed to start.tsx");
} else if (existsSync(startTsxPath)) {
  console.log("   ✓ Already start.tsx");
}

// 9. Update tsconfig.json for JSX support
console.log("\n9. Updating tsconfig.json for JSX...");
const cliTsconfigPath = join(ROOT, "packages/cli/tsconfig.json");
if (existsSync(cliTsconfigPath)) {
  let tsconfig = readFileSync(cliTsconfigPath, "utf-8");
  if (!tsconfig.includes('"jsx"')) {
    tsconfig = tsconfig.replace(
      '"compilerOptions": {',
      '"compilerOptions": {\n    "jsx": "react-jsx",'
    );
    writeFileSync(cliTsconfigPath, tsconfig);
    console.log("   ✓ Added jsx: react-jsx to tsconfig.json");
  } else {
    console.log("   ✓ JSX already configured");
  }
}

console.log("\n✅ Strip complete!\n");
