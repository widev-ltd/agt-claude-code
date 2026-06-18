// Copyright (c) 2026 AGT benchmark contributors. MIT License.
//
// prepare-context.mjs (Claude Code) — stage the build-context inputs the CC
// Dockerfiles COPY, from their canonical repo locations. Staged artifacts are
// .gitignored. Run before docker build:
//
//   node prepare-context.mjs
//
// Stages into experiment/ (the compose build context):
//   - containers/corporate-ca.pem   <- ../../agt-opencode/verify/corporate-ca.pem
//       (the exported corporate root CA is kept once in agt-opencode/verify; the
//        CC image needs the same CA. If the repos are not siblings, set
//        CORPORATE_CA to an explicit path.)
//   - plugin-src/                   <- agt-claude-code/plugins + .claude-plugin etc.
//       the agt-governance plugin tree (INCLUDING its built vendor/ SDK) so the
//       local-marketplace install works offline. Run scripts/build-vendor.mjs
//       first so vendor/ exists.

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));       // experiment/containers
const EXPERIMENT = resolve(HERE, "..");                      // experiment/
const REPO = resolve(EXPERIMENT, "..");                      // agt-claude-code/
const WORKSPACE = resolve(REPO, "..");                       // workspace root (repos are siblings)

const corporateCa =
  process.env.CORPORATE_CA || join(WORKSPACE, "agt-opencode", "verify", "corporate-ca.pem");

function need(path, label, hint) {
  if (!existsSync(path)) {
    console.error(`[prepare-context] MISSING ${label}: ${path}`);
    if (hint) console.error("  " + hint);
    process.exit(1);
  }
}

// 1) Corporate CA -> containers/corporate-ca.pem
need(corporateCa, "corporate-ca.pem", "Set CORPORATE_CA=<path> if the repos are not siblings.");
cpSync(corporateCa, join(HERE, "corporate-ca.pem"));
console.log(`[prepare-context] staged corporate-ca.pem -> ${join(HERE, "corporate-ca.pem")}`);

// 2) Plugin tree -> experiment/plugin-src/ (vendor/ must already be built)
const pluginRoot = join(REPO, "plugins", "agt-governance");
need(pluginRoot, "plugins/agt-governance", "Is this the agt-claude-code repo?");
need(
  join(pluginRoot, "vendor", "agent-governance-sdk"),
  "plugins/agt-governance/vendor/agent-governance-sdk",
  "Run `node scripts/build-vendor.mjs` first so the vendored SDK exists.",
);

const dest = join(EXPERIMENT, "plugin-src");
mkdirSync(dest, { recursive: true });
// Copy the marketplace manifest + the plugin package. We copy the whole repo's
// plugin-relevant tree so a local-marketplace registration resolves offline.
cpSync(join(REPO, ".claude-plugin"), join(dest, ".claude-plugin"), { recursive: true });
cpSync(join(REPO, "plugins"), join(dest, "plugins"), { recursive: true });
console.log(`[prepare-context] staged plugin tree -> ${dest}`);

console.log("[prepare-context] done. Now: node gen-decoys.mjs >/dev/null && docker compose --profile <none|ssrf|live> build");
