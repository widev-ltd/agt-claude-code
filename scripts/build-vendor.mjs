// Copyright (c) 2026 AGT Governance plugin contributors.
// Licensed under the MIT License.
//
// build-vendor.mjs — author-side build step. Builds Microsoft's Agent
// Governance Toolkit TypeScript SDK from source and vendors it (plus its
// runtime dependency tree) into the plugin, so the published plugin is fully
// self-contained and end users never run npm.
//
// Run this once, and again whenever you refresh the AGT SDK source.
//
// Usage:
//   node scripts/build-vendor.mjs [--sdk-src <path>] [--skip-install] [--skip-build]
//
// --sdk-src       Path to the AGT TypeScript SDK source
//                 (default: ../agent-governance-toolkit/agent-governance-typescript
//                 resolved as a sibling of this plugin repo).
// --skip-install  Reuse an existing node_modules in the SDK source.
// --skip-build    Reuse an existing dist/ in the SDK source.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const PLUGIN_ROOT = join(REPO_ROOT, "plugins", "agt-governance");
const VENDOR_ROOT = join(PLUGIN_ROOT, "vendor", "agent-governance-sdk");
const VENDOR_NODE_MODULES = join(VENDOR_ROOT, "node_modules");
const SDK_PACKAGE_NAME = "@microsoft/agent-governance-sdk";

const args = parseArgs(process.argv.slice(2));
const sdkSrc = resolve(
  args["sdk-src"] ??
    join(REPO_ROOT, "..", "agent-governance-toolkit", "agent-governance-typescript"),
);

main();

function main() {
  step(`Plugin repo:  ${REPO_ROOT}`);
  step(`SDK source:   ${sdkSrc}`);

  const manifest = readSdkManifest();

  if (!args["skip-install"]) {
    // --legacy-peer-deps: the AGT SDK package.json pins mismatched
    // @typescript-eslint/eslint-plugin and parser versions (a dev-only
    // inconsistency); without this flag npm aborts with ERESOLVE.
    runNpm(
      ["install", "--legacy-peer-deps"],
      sdkSrc,
      "Installing SDK build + runtime dependencies",
    );
  } else {
    step("Skipping npm install (--skip-install)");
  }

  if (!args["skip-build"]) {
    runNpm(["run", "build"], sdkSrc, "Compiling the SDK (tsc)");
  } else {
    step("Skipping npm run build (--skip-build)");
  }

  const distEntry = join(sdkSrc, "dist", "index.js");
  if (!existsSync(distEntry)) {
    fail(`SDK build did not produce ${distEntry}. Check the tsc output above.`);
  }

  step("Resetting vendor directory");
  rmSync(VENDOR_ROOT, { recursive: true, force: true });
  mkdirSync(VENDOR_NODE_MODULES, { recursive: true });

  step(`Vendoring ${SDK_PACKAGE_NAME} (dist + package.json + LICENSE)`);
  const sdkDest = join(VENDOR_NODE_MODULES, "@microsoft", "agent-governance-sdk");
  mkdirSync(sdkDest, { recursive: true });
  cpSync(join(sdkSrc, "dist"), join(sdkDest, "dist"), { recursive: true });
  cpSync(join(sdkSrc, "package.json"), join(sdkDest, "package.json"));
  copyLicense(sdkSrc, sdkDest);

  step("Vendoring the SDK runtime dependency tree");
  const srcNodeModules = join(sdkSrc, "node_modules");
  const visited = new Set([SDK_PACKAGE_NAME]);
  const copied = [];
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    copyDependencyTree(dep, srcNodeModules, VENDOR_NODE_MODULES, visited, copied);
  }
  for (const name of copied.sort()) {
    step(`  + ${name}`);
  }

  step("Syntax-checking plugin scripts");
  for (const file of readdirSync(join(PLUGIN_ROOT, "scripts"))) {
    if (!file.endsWith(".mjs")) continue;
    const target = join(PLUGIN_ROOT, "scripts", file);
    const res = spawnSync(process.execPath, ["--check", target], {
      stdio: "inherit",
    });
    if (res.status !== 0) {
      fail(`node --check failed for ${file}`);
    }
    step(`  ok ${file}`);
  }

  step("Verifying vendored SDK entry point");
  const vendoredEntry = join(sdkDest, "dist", "index.js");
  if (!existsSync(vendoredEntry)) {
    fail(`Expected vendored entry missing: ${vendoredEntry}`);
  }

  console.log("");
  console.log("Done. Vendored SDK is self-contained at:");
  console.log(`  ${vendoredEntry}`);
  console.log("Commit the plugins/agt-governance/vendor/ directory to git.");
}

// ── SDK source ─────────────────────────────────────────────────────────────

function readSdkManifest() {
  const manifestPath = join(sdkSrc, "package.json");
  if (!existsSync(manifestPath)) {
    fail(
      `No package.json at ${manifestPath}.\n` +
        "Point --sdk-src at the cloned agent-governance-typescript directory.",
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== SDK_PACKAGE_NAME) {
    fail(
      `Expected package "${SDK_PACKAGE_NAME}" at ${sdkSrc}, found "${manifest.name}".`,
    );
  }
  return manifest;
}

// ── Dependency tree copy (mirrors AGT's own copyPackageDependencyTree) ──────

function copyDependencyTree(name, srcNodeModules, destNodeModules, visited, copied) {
  if (visited.has(name)) return;
  visited.add(name);

  const srcPkg = join(srcNodeModules, ...name.split("/"));
  const srcManifestPath = join(srcPkg, "package.json");
  if (!existsSync(srcManifestPath)) {
    fail(
      `Missing runtime dependency "${name}" under ${srcNodeModules}.\n` +
        "Re-run without --skip-install so npm fetches it.",
    );
  }

  const destPkg = join(destNodeModules, ...name.split("/"));
  mkdirSync(dirname(destPkg), { recursive: true });
  cpSync(srcPkg, destPkg, { recursive: true });
  copied.push(name);

  const manifest = JSON.parse(readFileSync(srcManifestPath, "utf8"));
  for (const child of Object.keys(manifest.dependencies ?? {})) {
    copyDependencyTree(child, srcNodeModules, destNodeModules, visited, copied);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function runNpm(npmArgs, cwd, label) {
  step(`${label} ...`);
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const res = spawnSync(npmCmd, npmArgs, { cwd, stdio: "inherit" });
  if (res.status !== 0) {
    fail(
      `npm ${npmArgs.join(" ")} failed in ${cwd}.\n` +
        "If this is a corporate-proxy TLS error, install the corporate CA in your\n" +
        "OS trust store (and on Node 22+ set NODE_OPTIONS=--use-system-ca), then\n" +
        "re-run. Disabling strict-ssl works but turns off TLS verification.",
    );
  }
}

function copyLicense(srcDir, destDir) {
  const candidates = [
    join(srcDir, "LICENSE"),
    join(srcDir, "LICENSE.md"),
    join(srcDir, "..", "LICENSE"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cpSync(candidate, join(destDir, "LICENSE"));
      return;
    }
  }
  step("  (no SDK LICENSE file found to copy — see plugin NOTICE for attribution)");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skip-install" || arg === "--skip-build") {
      out[arg.slice(2)] = true;
    } else if (arg === "--sdk-src") {
      out["sdk-src"] = argv[i + 1];
      i += 1;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function step(message) {
  console.log(`[build-vendor] ${message}`);
}

function fail(message) {
  console.error(`\n[build-vendor] ERROR: ${message}\n`);
  process.exit(1);
}
