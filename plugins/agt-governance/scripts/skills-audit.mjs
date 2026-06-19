// Copyright (c) 2026 AGT Governance plugin contributors.
// Licensed under the MIT License.
//
// skills-audit.mjs — proactive (Tier-2) supply-chain audit runnable for Claude
// Code. Walks one or more skill directories, runs the full skill scan + the
// transitive dependency resolution + an installed vulnerability scanner
// (trivy / osv-scanner / pip-audit, auto-detected), and writes a `scanned`
// attestation per skill keyed EXACTLY as the runtime gate looks it up. A later
// PreToolUse decision is then a cheap cache hit — no scanner spawn, no first-run
// prompt.
//
// This runs OUTSIDE the tool-call hot path (the operator invokes it), so it is
// the only place the governance plugin ever spawns a scanner subprocess. It
// degrades gracefully: with no scanner installed, the skill scan + metadata
// hygiene still produce a useful attestation.
//
//   node skills-audit.mjs <dir> [<dir> ...] [--scanner trivy|osv-scanner|pip-audit]
//
// <dir> may be a single skill directory (contains SKILL.md) or a parent that
// holds many skill subdirectories (e.g. ~/.claude/skills); both are handled.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPolicy } from "./policy.mjs";
import { auditSkillDir } from "./skills.mjs";
import { writeFileAtomicSync } from "./session-store.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(SCRIPTS_DIR);
const DEFAULT_POLICY_PATH = join(PLUGIN_ROOT, "config", "default-policy.json");

await main();

async function main() {
  const argv = process.argv.slice(2);
  const dirs = [];
  let scannerCmd = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scanner") {
      scannerCmd = argv[++i] ?? null;
    } else if (a === "-h" || a === "--help") {
      printHelp();
      return;
    } else {
      dirs.push(a);
    }
  }
  if (dirs.length === 0) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  // Persist attestations to the same data dir the hook uses, so a cert written
  // here is found by the runtime gate.
  const dataDir = process.env.CLAUDE_PLUGIN_DATA
    ? String(process.env.CLAUDE_PLUGIN_DATA)
    : join(homedir(), ".claude", "agt");
  process.env.AGT_SESSION_STORE = "disk";
  if (!process.env.CLAUDE_PLUGIN_DATA) {
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
  }

  const state = await loadPolicy({ defaultPolicyPath: DEFAULT_POLICY_PATH, extensionRoot: PLUGIN_ROOT });
  const skillPolicy = state.policy.skill;
  const depsPolicy = state.policy.deps;
  if (!skillPolicy) {
    console.error("Skill governance is disabled in the active policy (skillPolicies.enabled=false). Nothing to audit.");
    process.exitCode = 1;
    return;
  }

  const skillDirs = [];
  for (const d of dirs) {
    skillDirs.push(...expandSkillDirs(resolve(d)));
  }
  if (skillDirs.length === 0) {
    console.error("No skill directories found under the given path(s).");
    process.exitCode = 1;
    return;
  }

  let failures = 0;
  let latestDbVersion = null;
  let latestScanner = null;
  for (const skillDir of skillDirs) {
    const summary = await auditSkillDir(skillDir, { skillPolicy, depsPolicy, scannerCmd });
    printSummary(summary);
    if (summary.vulnDbVersion) {
      latestDbVersion = summary.vulnDbVersion;
      latestScanner = summary.scanner ?? latestScanner;
    }
    if (summary.error || !summary.persisted) {
      failures++;
    }
  }

  // Cache the scanner's CURRENT vuln-DB version so the runtime gate can enforce
  // the attestation DB-version binding WITHOUT spawning a scanner (the hot path
  // must stay scanner-free). A later DB bump makes existing certs stale → the
  // gate re-prompts for a re-audit. Only written when a real scan produced a
  // version (no scanner → leave any prior cache untouched).
  if (latestDbVersion) {
    try {
      writeFileAtomicSync(
        join(dataDir, "scanner-db-version.json"),
        `${JSON.stringify({ version: latestDbVersion, scanner: latestScanner, writtenMs: Date.now() })}\n`,
      );
    } catch { /* best-effort: a cache-write failure just means age-only freshness */ }
  }

  console.log(`\nAudited ${skillDirs.length} skill(s); ${failures} could not be fully attested.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

// A path is a "skill dir" if it directly contains a SKILL.md. Otherwise treat it
// as a parent and return its immediate subdirectories that are skill dirs.
function expandSkillDirs(root) {
  try {
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  if (isSkillDir(root)) return [root];
  const out = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const child = join(root, entry.name);
        if (isSkillDir(child)) out.push(child);
      }
    }
  } catch { /* unreadable → none */ }
  return out;
}

function isSkillDir(dir) {
  return ["SKILL.md", "skill.md", "skill.yaml", "skill.yml", "skill.json"].some((n) => existsSync(join(dir, n)));
}

function printSummary(s) {
  console.log(`\n# ${s.skillDir}`);
  if (s.error) {
    console.log(`  ERROR: ${s.error}`);
    return;
  }
  console.log(`  attestation key: ${s.key}`);
  console.log(`  scanner:         ${s.scanner ?? "none installed (skill scan + metadata only)"}`);
  console.log(`  resolved deps:   ${s.resolved.length}${s.fromLockfile ? " (from lockfile)" : ""}`);
  console.log(`  findings:        ${s.findings.length}`);
  for (const f of s.findings.slice(0, 20)) {
    console.log(`    - [${f.severity}] ${f.kind} ${f.file ? `(${f.file})` : ""}: ${f.detail ?? ""}`);
  }
  if (s.findings.length > 20) console.log(`    … +${s.findings.length - 20} more`);
  if (s.note) console.log(`  note: ${s.note}`);
  console.log(`  attestation written: ${s.persisted ? "yes" : "NO (cache write failed)"}`);
}

function printHelp() {
  console.log([
    "skills-audit.mjs — proactive supply-chain audit for Claude Code skills",
    "",
    "Usage: node skills-audit.mjs <dir> [<dir> ...] [--scanner trivy|osv-scanner|pip-audit]",
    "",
    "  <dir>        a skill directory (containing SKILL.md) OR a parent of many",
    "  --scanner    force a specific vulnerability scanner (default: auto-detect)",
    "",
    "Writes a `scanned` attestation per skill so the runtime gate is a cache hit.",
  ].join("\n"));
}
