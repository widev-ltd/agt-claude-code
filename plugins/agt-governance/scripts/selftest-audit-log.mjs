// selftest-audit-log.mjs — the append-only NDJSON audit log + single-writer
// lock. Verifies: the on-disk format is NDJSON (not the legacy JSON array); the
// SHA-256 hash chain verifies; CONCURRENT same-session hook PROCESSES serialize
// on the lock so the chain never forks (the reason the lock exists), even under
// extreme contention (timed-out appends are SKIPPED, not forked); a stale lock
// that cannot be removed never hangs the hook; a legacy JSON-array log migrates
// to NDJSON without losing entries; and tampering is still detected. Spawns the
// REAL hook (matches selftest-crossprocess), so the cross-process lock is
// genuinely exercised. Run: node selftest-audit-log.mjs

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "agt-hook.mjs");
const POLICY = join(HERE, "..", "config", "default-policy.json");

let fail = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); if (!c) fail++; };

function spawnHook(dataDir, ev) {
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, [HOOK], {
      env: { ...process.env, AGT_COPILOT_POLICY_PATH: POLICY, CLAUDE_PLUGIN_DATA: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    c.on("error", rej);
    c.on("close", (code) => res({ code }));
    c.stdin.write(JSON.stringify(ev));
    c.stdin.end();
  });
}
// Variant that kills the hook after timeoutMs and reports whether it returned on
// its own — used to assert "no hang".
function spawnHookTimed(dataDir, ev, timeoutMs) {
  return new Promise((res) => {
    const c = spawn(process.execPath, [HOOK], {
      env: { ...process.env, AGT_COPILOT_POLICY_PATH: POLICY, CLAUDE_PLUGIN_DATA: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let done = false;
    const finish = (returned, code) => { if (!done) { done = true; clearTimeout(t); res({ returned, code }); } };
    const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* ignore */ } finish(false, null); }, timeoutMs);
    c.on("close", (code) => finish(true, code));
    c.on("error", () => finish(false, null));
    c.stdin.write(JSON.stringify(ev));
    c.stdin.end();
  });
}
const benign = (sid) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hello" }, session_id: sid, cwd: HERE });
const auditHash = (e) => createHash("sha256").update(`${e.timestamp}|${e.agentId}|${e.action}|${e.decision}|${e.previousHash}`).digest("hex");
const readNdjson = (p) => readFileSync(p, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
function chainValid(entries) {
  for (let i = 0; i < entries.length; i++) {
    if (i > 0 && String(entries[i].previousHash) !== String(entries[i - 1].hash)) return false;
    if (String(entries[i].hash) !== auditHash(entries[i])) return false;
  }
  return true;
}

// 1. Sequential → NDJSON + valid chain
{
  const dir = mkdtempSync(join(tmpdir(), "agt-audit-seq-"));
  for (let i = 0; i < 5; i++) await spawnHook(dir, benign("seq"));
  const path = join(dir, "audit-log.json");
  ok("sequential: on-disk format is NDJSON (not a JSON array)", !readFileSync(path, "utf-8").trimStart().startsWith("["));
  const e = readNdjson(path);
  ok(`sequential: 5 entries recorded (got ${e.length})`, e.length === 5);
  ok("sequential: hash chain verifies", chainValid(e));
}

// 2. PARALLEL same-session (moderate) → lock serializes; all present, no fork
{
  const dir = mkdtempSync(join(tmpdir(), "agt-audit-par-"));
  const N = 12;
  await Promise.all(Array.from({ length: N }, () => spawnHook(dir, benign("par"))));
  const e = readNdjson(join(dir, "audit-log.json"));
  ok(`parallel: all ${N} concurrent appends present (got ${e.length})`, e.length === N);
  ok("parallel: no duplicate previousHash (no chain fork)", new Set(e.map((x) => x.previousHash)).size === e.length);
  ok("parallel: single linear chain verifies (lock serialized writers)", chainValid(e));
}

// 2b. HEAVY parallel → the chain NEVER forks even when the lock times out.
//     Timed-out appends are SKIPPED (not appended off a stale previous-hash), so
//     some best-effort entries MAY be dropped (count <= N) but the on-disk chain
//     stays fork-free and verifiable. (Regression: A-AUDIT found forks here.)
{
  const dir = mkdtempSync(join(tmpdir(), "agt-audit-heavy-"));
  const N = 64;
  await Promise.all(Array.from({ length: N }, () => spawnHook(dir, benign("heavy"))));
  const e = readNdjson(join(dir, "audit-log.json"));
  ok(`heavy(N=${N}): no fork — every entry has a unique previousHash (got ${e.length})`,
    new Set(e.map((x) => x.previousHash)).size === e.length);
  ok("heavy: chain verifies under extreme concurrency (no false-INVALID)", chainValid(e));
  ok("heavy: 1..N entries (best-effort drop under contention allowed)", e.length >= 1 && e.length <= N);
}

// 3. Legacy JSON-array → migrated to NDJSON without loss
{
  const dir = mkdtempSync(join(tmpdir(), "agt-audit-leg-"));
  const path = join(dir, "audit-log.json");
  const g = "0".repeat(64);
  const a = { timestamp: "2026-01-01T00:00:00.000Z", agentId: "claude-code:leg", action: "tool.Bash", decision: "allow", previousHash: g };
  a.hash = auditHash(a);
  const b = { timestamp: "2026-01-01T00:00:01.000Z", agentId: "claude-code:leg", action: "tool.Read", decision: "allow", previousHash: a.hash };
  b.hash = auditHash(b);
  writeFileSync(path, JSON.stringify([a, b], null, 2) + "\n", "utf-8");
  await spawnHook(dir, benign("leg"));
  ok("legacy: migrated to NDJSON (no leading '[')", !readFileSync(path, "utf-8").trimStart().startsWith("["));
  const e = readNdjson(path);
  ok(`legacy: 2 legacy + 1 new entries preserved (got ${e.length})`, e.length === 3);
  ok("legacy: full chain verifies after migration", chainValid(e) && e[2].previousHash === b.hash);
}

// 3b. Stale lock that is a DIRECTORY must NOT hang the hook (A-FAILSAFE regress).
{
  const dir = mkdtempSync(join(tmpdir(), "agt-audit-staledir-"));
  const lock = join(dir, "audit-log.json.lock");
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 60_000); // older than staleMs
  utimesSync(lock, old, old);
  const r = await spawnHookTimed(dir, benign("staledir"), 6000);
  ok("stale lock-dir: hook returns (no infinite spin)", r.returned === true);
  ok("stale lock-dir: decision still emitted (exit 0)", r.code === 0);
}

// 4. Tamper detection
{
  const dir = mkdtempSync(join(tmpdir(), "agt-audit-tamper-"));
  const path = join(dir, "audit-log.json");
  for (let i = 0; i < 3; i++) await spawnHook(dir, benign("tmp"));
  const e = readNdjson(path);
  e[0].decision = e[0].decision === "deny" ? "allow" : "deny"; // edit content, leave stored hash
  writeFileSync(path, e.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf-8");
  ok("tamper: editing a recorded decision breaks chain verification", !chainValid(readNdjson(path)));
}

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
process.exit(fail === 0 ? 0 : 1);
