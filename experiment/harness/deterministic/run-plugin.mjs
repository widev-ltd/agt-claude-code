// Copyright (c) 2026 AGT benchmark contributors. MIT License.
//
// run-plugin.mjs (Claude Code) — the zero-key deterministic PLUGIN runner.
//
// It spawns the REAL hook entry point
// (agt-claude-code/plugins/agt-governance/scripts/agt-hook.mjs) — no
// reimplementation — writes a Claude Code hook-event JSON to its stdin (rendered
// by adapters/host.mjs renderCase()), and reads the decision JSON from stdout.
// This is exactly how Claude Code invokes the hook, so we measure the real
// PreToolUse/PostToolUse/UserPromptSubmit behaviour.
//
// SCOPE (per BENCHMARK-PLAN.md track-1): deterministic = PLUGIN column only.
// native is live-only; ungoverned is allow-by-construction; layered's native
// component is live-only. This runner returns the RAW hook decision for the
// plugin config.
//
// CONTRACT (advisor-hardened):
//   - Spawn the hook AT ITS REAL PATH so its relative vendor/ + config/ resolve.
//   - Child env: AGT_COPILOT_POLICY_PATH = the config's resolved policy (the same
//     policy the OC side loads); CLAUDE_PLUGIN_DATA = a throwaway tmp dir so the
//     audit log is isolated and never grows results/.
//   - Decision = STDOUT JSON only; stderr captured separately (diagnostics).
//   - EMPTY stdout == allow ONLY on exit 0. A nonzero exit / spawn failure with
//     empty stdout is a HARNESS ERROR (e.g. broken vendor import), NOT allow —
//     otherwise a broken plugin would score every case as allowed. We throw.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HOST, renderCase } from "../../adapters/host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");        // agt-claude-code/
const HOOK_PATH = join(REPO_ROOT, "plugins", "agt-governance", "scripts", "agt-hook.mjs");
const DEFAULT_POLICY = join(REPO_ROOT, "plugins", "agt-governance", "config", "default-policy.json");

if (HOST !== "cc") {
  throw new Error(`run-plugin.mjs (CC) loaded the wrong adapter: HOST=${HOST}`);
}

/**
 * Resolve the policy path for a benchmark config object (configs/*.json).
 * policy_path is relative to the config file's directory (experiment/configs/).
 */
export function resolvePolicyForConfig(config, { configDir }) {
  if (!config?.policy_path) return DEFAULT_POLICY;
  return isAbsolute(config.policy_path) ? config.policy_path : resolve(configDir, config.policy_path);
}

/**
 * "Load" the engine for a CC config. CC has no in-process state — each case is a
 * fresh hook process — so this just captures the per-config env the spawns need.
 */
export async function loadEngineForConfig(config, { configDir }) {
  const policyPath = resolvePolicyForConfig(config, { configDir });
  const dataDir = mkdtempSync(join(tmpdir(), "agt-bench-cc-"));
  return { state: { policyPath, dataDir }, policyPath, mode: "enforce", source: "config" };
}

function spawnHook(eventObj, { policyPath, dataDir }) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      env: {
        ...process.env,
        AGT_COPILOT_POLICY_PATH: policyPath,
        CLAUDE_PLUGIN_DATA: dataDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", rejectP);
    child.on("close", (code) => resolveP({ code, out, err }));
    child.stdin.write(JSON.stringify(eventObj));
    child.stdin.end();
  });
}

/**
 * Evaluate ONE rendered case against the real hook. Returns the RAW hook
 * decision (parsed stdout, or undefined for an allow) + timing.
 * @returns {{call:string, raw:any, latencyMs:number, host:"cc", stderr:string}}
 */
export async function evaluateRendered(state, rendered) {
  // Strip the harness-only `call` before sending to the hook (the hook keys off
  // hook_event_name). Keep `call` for the normalizer.
  const { call, ...eventObj } = rendered;
  const t0 = performance.now();
  const { code, out, err } = await spawnHook(eventObj, state);
  const latencyMs = performance.now() - t0;

  const trimmed = out.trim();
  let raw;
  if (trimmed === "") {
    // Empty stdout is ALLOW only if the hook exited cleanly. A nonzero exit with
    // no decision is a harness/plugin error — fail loudly rather than score allow.
    if (code !== 0) {
      throw new Error(
        `CC hook produced no stdout AND exited ${code} for call=${call}; treating as harness error, NOT allow. stderr: ${err.slice(0, 500)}`,
      );
    }
    raw = undefined; // genuine allow
  } else {
    try {
      raw = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`CC hook stdout is not valid JSON for call=${call}: ${e.message}. stdout: ${trimmed.slice(0, 500)}`);
    }
  }
  return { call, raw, latencyMs, host: "cc", stderr: err };
}

export async function evaluateCase(state, kase, opts = {}) {
  const rendered = renderCase(kase.abstract_action, opts);
  const out = await evaluateRendered(state, rendered);
  return { ...out, rendered };
}

export { renderCase, HOST };
