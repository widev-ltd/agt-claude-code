// Copyright (c) 2026 AGT Governance plugin contributors.
// Licensed under the MIT License.
//
// parity-check.mjs — verify the shared governance engine is BYTE-IDENTICAL
// across all three copies, and (advisory) report whether the OpenCode bundle
// looks stale relative to its source.
//
// The three copies (canonical is the source of truth):
//   A. canonical  agt-claude-code/plugins/agt-governance/scripts/        <- truth
//   B. mirror     agt-claude-code/experiment/plugin-src/.../scripts/     (gitignored)
//   C. opencode   agt-opencode/plugin/src/
//
// WHAT IT ENFORCES (exit 1 on any failure):
//   - each of the 11 shared modules has an IDENTICAL sha-256 in A, B and C.
//   A module that is missing from any copy is a failure too.
//
// WHAT IT ONLY REPORTS (advisory, never fails the run on its own):
//   - bundle freshness: whether any agt-opencode/plugin/src/*.mjs is NEWER (mtime)
//     than the built bundle agt-opencode/assets/agt-governance.js. mtime is a
//     heuristic; the AUTHORITATIVE freshness check is "rebuild + git diff", which
//     the CI workflow does (it cannot be done reliably here without running
//     esbuild and mutating the tree).
//
// Usage:
//   node parity-check.mjs           # full table, exit 1 on drift
//   node parity-check.mjs --json    # machine-readable summary
//
// This script ONLY reads files. It never writes and never runs the engine.

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Resolve all paths relative to THIS file so parity-check works no matter the
// process cwd (so wiring it into run-selftests.mjs and CI both behave).
const CANONICAL_DIR = HERE;
const AGT_CC_ROOT = resolve(HERE, "..", "..", "..");   // agt-claude-code
const WORKSPACE_ROOT = resolve(AGT_CC_ROOT, "..");     // claude_code_governance

const MIRROR_DIR = join(
  AGT_CC_ROOT,
  "experiment",
  "plugin-src",
  "plugins",
  "agt-governance",
  "scripts",
);
const OC_SRC_DIR = join(WORKSPACE_ROOT, "agt-opencode", "plugin", "src");
const OC_BUNDLE = join(WORKSPACE_ROOT, "agt-opencode", "assets", "agt-governance.js");

// MUST stay in lockstep with sync-shared.mjs's SHARED_MODULES.
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

const ALL_COPIES = [
  { key: "canonical", dir: CANONICAL_DIR },
  { key: "mirror", dir: MIRROR_DIR },
  { key: "opencode", dir: OC_SRC_DIR },
];

// A copy participates in the parity check only if its directory exists. This
// keeps the check HONEST in two contexts:
//   - local workspace: all 3 dirs exist (canonical + gitignored mirror + OC
//     sibling repo) -> full 3-way byte-parity is enforced.
//   - single-repo CI checkout: the OC sibling repo and the gitignored mirror are
//     NOT present, so only the canonical copy participates and the check passes
//     trivially with a clear note. We never silently treat an ABSENT-because-
//     not-checked-out copy as a parity failure.
// The canonical dir is always present (this script lives in it). Per-file
// missingness WITHIN a present copy is still a drift failure (a copy that has
// the dir but is missing a shared module is broken).
const COPIES = ALL_COPIES.filter((c) => c.key === "canonical" || existsSync(c.dir));
const SKIPPED_COPIES = ALL_COPIES.filter((c) => !COPIES.includes(c));

const JSON_OUT = process.argv.includes("--json");

function rel(p) {
  return relative(WORKSPACE_ROOT, p).replace(/\\/g, "/");
}

function sha256OrNull(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ── 1. Shared-module byte-parity ─────────────────────────────────────────────

function checkModuleParity() {
  const rows = [];
  let drift = 0;
  for (const f of SHARED_MODULES) {
    // Hashes only for the PRESENT copies (COPIES). canonical is COPIES[0].
    const hashes = COPIES.map((c) => sha256OrNull(join(c.dir, f)));
    const present = hashes.map((h) => h !== null);
    const allPresent = present.every(Boolean);
    const canonical = hashes[0];
    const inParity = allPresent && hashes.every((h) => h === canonical);
    if (!inParity) drift += 1;
    rows.push({ file: f, hashes, present, inParity });
  }
  return { rows, drift };
}

// ── 2. Bundle freshness (advisory) ───────────────────────────────────────────

function checkBundleFreshness() {
  if (!existsSync(OC_BUNDLE)) {
    return {
      status: "missing",
      message: `OC bundle not found at ${rel(OC_BUNDLE)} (gitignored; run \`npm run build\`).`,
      newerSources: [],
    };
  }
  const bundleMtime = statSync(OC_BUNDLE).mtimeMs;
  const srcFiles = existsSync(OC_SRC_DIR)
    ? readdirSync(OC_SRC_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".ts"))
    : [];
  const newer = [];
  for (const f of srcFiles) {
    const m = statSync(join(OC_SRC_DIR, f)).mtimeMs;
    if (m > bundleMtime) newer.push(f);
  }
  return {
    status: newer.length ? "stale-maybe" : "fresh-maybe",
    message:
      newer.length === 0
        ? "OC bundle mtime is newer than every plugin/src file (likely fresh)."
        : `OC bundle may be STALE: ${newer.length} source file(s) are newer than the bundle.`,
    newerSources: newer.sort(),
  };
}

// ── render ───────────────────────────────────────────────────────────────────

function shortHash(h) {
  return h ? h.slice(0, 10) : "MISSING";
}

function main() {
  const parity = checkModuleParity();
  const bundle = checkBundleFreshness();

  const copyKeys = COPIES.map((c) => c.key);

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          ok: parity.drift === 0,
          drift: parity.drift,
          copiesChecked: copyKeys,
          copiesSkipped: SKIPPED_COPIES.map((c) => c.key),
          modules: parity.rows.map((r) => {
            const m = { file: r.file, inParity: r.inParity };
            COPIES.forEach((c, i) => {
              m[c.key] = r.hashes[i];
            });
            return m;
          }),
          bundle,
        },
        null,
        2,
      ),
    );
    process.exit(parity.drift === 0 ? 0 : 1);
  }

  console.log("AGT shared-engine parity check");
  console.log(`  canonical (truth): ${rel(CANONICAL_DIR)}`);
  console.log(`  mirror:            ${rel(MIRROR_DIR)}${COPIES.some((c) => c.key === "mirror") ? "" : "  (absent — not checked out)"}`);
  console.log(`  opencode:          ${rel(OC_SRC_DIR)}${COPIES.some((c) => c.key === "opencode") ? "" : "  (absent — sibling repo not checked out)"}`);
  if (SKIPPED_COPIES.length) {
    console.log(`  NOTE: ${SKIPPED_COPIES.map((c) => c.key).join(", ")} absent — parity enforced across [${copyKeys.join(", ")}] only.`);
  }
  console.log("");

  // Table header — one hash column per PRESENT copy.
  const head =
    `${"module".padEnd(22)} ` +
    copyKeys.map((k) => k.padEnd(12)).join(" ") +
    " result";
  console.log(head);
  console.log("-".repeat(head.length));
  for (const r of parity.rows) {
    const cols = r.hashes.map((h) => shortHash(h).padEnd(12)).join(" ");
    const result = r.inParity ? "PARITY" : "DRIFT";
    console.log(`${r.file.padEnd(22)} ${cols} ${result}`);
  }

  console.log("");
  console.log(`Bundle freshness (advisory): ${bundle.message}`);
  if (bundle.newerSources.length) {
    console.log(`  newer than bundle: ${bundle.newerSources.join(", ")}`);
  }
  console.log("  (authoritative bundle check = `node build.mjs && git diff --exit-code assets/agt-governance.js` in CI)");

  console.log("");
  const scope = copyKeys.length === ALL_COPIES.length ? "all 3 copies" : `the ${copyKeys.length} present copy/copies [${copyKeys.join(", ")}]`;
  if (parity.drift === 0) {
    console.log(`PARITY OK — all ${SHARED_MODULES.length} shared modules are byte-identical across ${scope}.`);
    process.exit(0);
  }
  console.log(
    `PARITY FAILED — ${parity.drift} of ${SHARED_MODULES.length} shared module(s) DRIFTED across ${scope}. ` +
      "Reconcile with `node sync-shared.mjs` (canonical is the source of truth).",
  );
  process.exit(1);
}

main();
