// Copyright (c) 2026 AGT Governance plugin contributors.
// Licensed under the MIT License.
//
// sync-shared.mjs — propagate the shared governance engine FROM the single
// source of truth (this canonical Claude Code scripts dir) TO the two other
// byte-identical copies:
//   1. the gitignored CC mirror  experiment/plugin-src/plugins/agt-governance/scripts/
//   2. the OpenCode plugin source agt-opencode/plugin/src/
//
// WHAT IT SYNCS:
//   - the 11 shared engine modules (SHARED_MODULES below), and
//   - the selftest-*.mjs files that already exist in ALL THREE copies.
// It deliberately does NOT create files that are missing from a destination:
// each copy carries host-specific selftests (e.g. OC has selftest-precedence /
// selftest-profiles; CC has selftest-audit-log / selftest-crossprocess) that are
// NOT shared and must not be cross-pollinated. A selftest is only synced when it
// is present in the canonical dir AND in that destination already.
//
// The copy is byte-for-byte (no transform). It is idempotent: a file that is
// already identical is skipped and reported as "ok". Run:
//   node sync-shared.mjs            # copy drift from canonical -> mirror + OC
//   node sync-shared.mjs --check    # report what WOULD change, exit 1 on drift
//   node sync-shared.mjs --dry-run  # alias for --check
//
// NOTE: This script only ever READS the canonical copy and WRITES the two
// destinations. It can never change the source of truth.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// The canonical source of truth is THIS directory:
//   agt-claude-code/plugins/agt-governance/scripts/
const CANONICAL_DIR = HERE;

// Walk up to the workspace root that contains both sibling repos.
// HERE = <root>/agt-claude-code/plugins/agt-governance/scripts
const AGT_CC_ROOT = resolve(HERE, "..", "..", "..");           // agt-claude-code
const WORKSPACE_ROOT = resolve(AGT_CC_ROOT, "..");             // claude_code_governance

const MIRROR_DIR = join(
  AGT_CC_ROOT,
  "experiment",
  "plugin-src",
  "plugins",
  "agt-governance",
  "scripts",
);
const OC_SRC_DIR = join(WORKSPACE_ROOT, "agt-opencode", "plugin", "src");

const DESTINATIONS = [
  { name: "mirror (experiment/plugin-src)", dir: MIRROR_DIR },
  { name: "opencode (plugin/src)", dir: OC_SRC_DIR },
];

// The 11 shared governance engine modules. This list is the contract: it MUST
// stay in lockstep with parity-check.mjs's SHARED_MODULES.
const SHARED_MODULES = [
  "policy.mjs",
  "deps.mjs",
  "skills.mjs",
  "attestation.mjs",
  "session-store.mjs",
  "exfil.mjs",
  "dlp.mjs",
  "content-safety.mjs",
  "rate-limit.mjs",
  "poisoning.mjs",
  "intent-judge.mjs",
];

// Every selftest-*.mjs in the canonical dir is a CANDIDATE; it is only synced to
// a destination that already has a file by that name (see module docstring).
function canonicalSelftests() {
  return readdirSync(CANONICAL_DIR)
    .filter((f) => /^selftest-.*\.mjs$/.test(f))
    .sort();
}

const CHECK = process.argv.includes("--check") || process.argv.includes("--dry-run");

function rel(p) {
  return relative(WORKSPACE_ROOT, p).replace(/\\/g, "/");
}

// Returns "copied" | "ok" | "skip-missing-dest" | "would-copy".
function syncOne(srcPath, destPath, { selftest }) {
  if (!existsSync(srcPath)) {
    // A shared module missing from the canonical dir is a hard error; a missing
    // canonical selftest simply means there is nothing to propagate.
    return selftest ? "skip-missing-src" : "missing-src";
  }
  // Selftests are only mirrored to a destination that already declares them.
  if (selftest && !existsSync(destPath)) {
    return "skip-missing-dest";
  }
  const src = readFileSync(srcPath);
  const dst = existsSync(destPath) ? readFileSync(destPath) : null;
  if (dst !== null && src.equals(dst)) {
    return "ok";
  }
  if (CHECK) {
    return "would-copy";
  }
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, src);
  return "copied";
}

function main() {
  const selftests = canonicalSelftests();
  let changed = 0;
  let errors = 0;

  console.log(
    `sync-shared: source of truth = ${rel(CANONICAL_DIR)}${CHECK ? "  (--check: no writes)" : ""}`,
  );

  for (const dest of DESTINATIONS) {
    console.log(`\n→ ${dest.name}  [${rel(dest.dir)}]`);

    // 1) Shared engine modules (must exist; missing source is an error).
    for (const f of SHARED_MODULES) {
      const r = syncOne(join(CANONICAL_DIR, f), join(dest.dir, f), { selftest: false });
      if (r === "missing-src") {
        console.log(`   ERROR  ${f.padEnd(28)} not found in canonical dir`);
        errors += 1;
      } else if (r === "copied") {
        console.log(`   copied ${f.padEnd(28)} (drift fixed)`);
        changed += 1;
      } else if (r === "would-copy") {
        console.log(`   DRIFT  ${f.padEnd(28)} would be overwritten from canonical`);
        changed += 1;
      } else {
        console.log(`   ok     ${f.padEnd(28)}`);
      }
    }

    // 2) Shared selftests (only those that already exist in this destination).
    for (const f of selftests) {
      const r = syncOne(join(CANONICAL_DIR, f), join(dest.dir, f), { selftest: true });
      if (r === "skip-missing-dest") {
        // Host-specific selftest not shared with this destination — intentional.
        continue;
      }
      if (r === "copied") {
        console.log(`   copied ${f.padEnd(28)} (selftest drift fixed)`);
        changed += 1;
      } else if (r === "would-copy") {
        console.log(`   DRIFT  ${f.padEnd(28)} selftest would be overwritten`);
        changed += 1;
      } else if (r === "ok") {
        console.log(`   ok     ${f.padEnd(28)} (selftest)`);
      }
    }
  }

  console.log("");
  if (errors) {
    console.log(`sync-shared: ${errors} ERROR(S) — a shared module is missing from the canonical dir.`);
    process.exit(2);
  }
  if (CHECK) {
    console.log(
      changed === 0
        ? "sync-shared --check: all copies are in sync."
        : `sync-shared --check: ${changed} file(s) DRIFTED from canonical. Run \`node sync-shared.mjs\` to fix.`,
    );
    process.exit(changed === 0 ? 0 : 1);
  }
  console.log(
    changed === 0
      ? "sync-shared: nothing to do — all copies already match canonical."
      : `sync-shared: copied ${changed} file(s) from canonical to the mirror + OC.`,
  );
  process.exit(0);
}

main();
