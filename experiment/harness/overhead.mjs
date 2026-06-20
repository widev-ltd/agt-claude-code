// overhead.mjs — REAL overhead measurement. No self-grading: wall-clock only.
// Measures (1) bare Node process startup, (2) the full CC hook end-to-end on
// current code for an ordinary call vs a skill-invocation call, (3) the in-process
// resident engine cost (what OpenCode pays), (4) the isolated skill/dep gate cost.
// Run: node experiment/harness/overhead.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SCRIPTS = join(REPO, "plugins", "agt-governance", "scripts");
const HOOK = join(SCRIPTS, "agt-hook.mjs");
const POLICY = join(REPO, "plugins", "agt-governance", "config", "default-policy.json");

const dataDir = mkdtempSync(join(tmpdir(), "agt-oh-data-"));
const work = mkdtempSync(join(tmpdir(), "agt-oh-work-"));
// A real skill on disk so the skill path actually runs scanSkill (not a stub).
const skillDir = join(work, "skills", "demo");
mkdirSync(join(skillDir, "scripts"), { recursive: true });
writeFileSync(join(skillDir, "SKILL.md"), "---\nname: demo\nallowed-capabilities: [network]\n---\n# demo\nFetches a URL.");
writeFileSync(join(skillDir, "scripts", "run.py"), "import requests\nrequests.get('https://api.example/x')\n");
const skillCmd = `python ${join(skillDir, "scripts", "run.py")}`;

const env = { ...process.env, AGT_COPILOT_POLICY_PATH: POLICY, CLAUDE_PLUGIN_DATA: dataDir };

function spawnOnce(args, stdinStr) {
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("error", rej);
    c.on("close", (code) => res({ code, out, err }));
    if (stdinStr != null) c.stdin.write(stdinStr);
    c.stdin.end();
  });
}

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, median: q(0.5), mean, p95: q(0.95), min: s[0], max: s[s.length - 1] };
}
const f = (x) => x.toFixed(1);
function line(label, st) {
  console.log(`  ${label.padEnd(42)} median ${f(st.median).padStart(7)}ms  mean ${f(st.mean).padStart(7)}ms  p95 ${f(st.p95).padStart(7)}ms`);
}

async function timeSpawns(label, args, stdinStr, n, warm) {
  for (let i = 0; i < warm; i++) await spawnOnce(args, stdinStr);
  const t = [];
  for (let i = 0; i < n; i++) {
    const a = performance.now();
    const r = await spawnOnce(args, stdinStr);
    t.push(performance.now() - a);
    if (r.code !== 0 && !r.out) { /* keep timing; note errors once */ if (i === 0) console.log(`    (note: ${label} exit=${r.code} stderr=${r.err.slice(0,120)})`); }
  }
  const st = stats(t);
  line(label, st);
  return st;
}

const N = 40, WARM = 5;
console.log(`\nREAL OVERHEAD — current code, ${N} spawns each (+${WARM} warmup). Host: CC (process-per-hook).\n`);
console.log("[1] Process-spawn cost (the CC per-hook tax: a fresh process every Pre/Post call)");
const bare = await timeSpawns("bare node startup (node -e '')", ["-e", ""], null, N, WARM);
const evtOrdinary = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(work, "x.txt") } });
const evtSkill = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: skillCmd }, cwd: work });
const hookOrd = await timeSpawns("full hook — ordinary call (Read)", [HOOK], evtOrdinary, N, WARM);
const hookSkill = await timeSpawns("full hook — skill invocation (scanSkill)", [HOOK], evtSkill, N, WARM);
console.log(`\n  => SDK+engine load on top of Node:   ~${f(hookOrd.median - bare.median)}ms (ordinary)`);
console.log(`  => skill/dep gate ADDS on a skill call: ~${f(hookSkill.median - hookOrd.median)}ms (delta skill - ordinary)`);

// [2] In-process resident cost (what OpenCode pays — engine stays loaded).
console.log("\n[2] In-process resident cost (what OpenCode pays: engine loaded once, no per-call spawn)");
process.env.AGT_COPILOT_POLICY_PATH = POLICY;
process.env.CLAUDE_PLUGIN_DATA = dataDir;
const pol = await import(pathToFileURL(join(SCRIPTS, "policy.mjs")).href);
const skills = await import(pathToFileURL(join(SCRIPTS, "skills.mjs")).href);
const rawPolicy = JSON.parse((await import("node:fs")).readFileSync(POLICY, "utf8"));
const compiled = pol.compilePolicy(rawPolicy);
const state = { policy: compiled };

async function timeFn(label, fn, n, warm) {
  for (let i = 0; i < warm; i++) await fn();
  const t = [];
  for (let i = 0; i < n; i++) { const a = performance.now(); await fn(); t.push(performance.now() - a); }
  const st = stats(t);
  // sub-ms: print in microseconds for readability
  const us = st.median < 1;
  console.log(`  ${label.padEnd(42)} median ${(us ? (st.median*1000).toFixed(1)+"us" : f(st.median)+"ms").padStart(9)}  mean ${(us ? (st.mean*1000).toFixed(1)+"us" : f(st.mean)+"ms").padStart(9)}  p95 ${(us ? (st.p95*1000).toFixed(1)+"us" : f(st.p95)+"ms").padStart(9)}`);
  return st;
}

const ip = (cmd) => ({ toolName: "Bash", toolArgs: { command: cmd }, cwd: work, sessionId: "oh" });
const ipRead = { toolName: "Read", toolArgs: { file_path: join(work, "x.txt") }, cwd: work, sessionId: "oh" };
await timeFn("evaluatePreToolUse — ordinary (Read)", () => pol.evaluatePreToolUse(state, ipRead), 500, 50);
await timeFn("evaluatePreToolUse — skill invocation", () => pol.evaluatePreToolUse(state, ip(skillCmd)), 300, 50);

// [3] Isolated skill/dep gate logic.
console.log("\n[3] Isolated skill/dep gate logic (the feature itself, in-process)");
await timeFn("checkSkillDeps — ordinary cmd (no-op path)", () => pol.checkSkillDeps(state, { command: "ls -la", cwd: work }), 2000, 100);
await timeFn("checkSkillDeps — skill cmd (gate runs)", () => pol.checkSkillDeps(state, { command: skillCmd, cwd: work }), 1000, 100);
const skillPol = compiled.skill;
await timeFn("scanSkill — full deep scan of the skill", () => skills.scanSkill(skillDir, skillPol), 500, 50);

rmSync(dataDir, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
console.log("\n(Reported numbers are wall-clock on THIS machine; absolute ms varies by hardware. The DELTAS are the honest signal.)");
