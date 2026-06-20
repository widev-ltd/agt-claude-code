// fp-popular.mjs — INDEPENDENT false-positive measurement. Runs the plugin's
// Tier-1 dependency heuristics over a REAL, EXTERNALLY-RANKED population of legit
// popular PyPI packages (hugovk top-pypi-packages — a corpus this project did NOT
// author). Every package here is a real, legitimate, widely-used package, so ANY
// deny/review is a FALSE POSITIVE. This replaces "0% FPR on 61 hand-picked cases"
// with a real FP rate on an external population. Pinned specs (so unpinned never
// fires) → the findings measured are the NAME/metadata heuristics (typosquat etc.).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(here, "..", "..", "plugins", "agt-governance", "scripts");
const deps = await import(pathToFileURL(join(ENGINE, "deps.mjs")).href);

const N = Number(process.argv[2] ?? 2000);
const data = JSON.parse(readFileSync(join(here, "data", "top-pypi-5000.json"), "utf8"));
const names = data.names.slice(0, N);

// The SHIPPED default dependency policy (enforce) — measure what actually ships.
const defPol = JSON.parse(readFileSync(join(ENGINE, "..", "config", "default-policy.json"), "utf8"));
const policy = deps.compileDepsPolicy(defPol.dependencyPolicies ?? { mode: "enforce" });

let denied = 0, reviewed = 0, allowed = 0;
const kinds = {};
const flagged = [];
for (const name of names) {
  const spec = { ecosystem: "pypi", name, spec: `${name}==1.0.0` };
  const findings = deps.scanDependencyMetadata([spec], policy);
  const d = deps.depsDecision(findings, policy);
  const decision = d?.decision ?? "allow";
  if (decision === "deny") denied++;
  else if (decision === "review") reviewed++;
  else { allowed++; continue; }
  for (const f of findings) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
  if (flagged.length < 40) flagged.push(`${name} → ${decision} (${findings.map((f) => f.kind).join(",")})`);
}

const pct = (n) => ((100 * n) / names.length).toFixed(2);
console.log(`\nINDEPENDENT FP measurement — plugin Tier-1 deps over ${names.length} REAL top PyPI packages`);
console.log(`source: ${data.source}`);
console.log(`policy: shipped default dependencyPolicies (mode=${policy.mode}, threshold=${policy.severityThreshold})\n`);
console.log(`  FALSE POSITIVE (hard deny):   ${denied}  (${pct(denied)}%)`);
console.log(`  FRICTION (review):            ${reviewed}  (${pct(reviewed)}%)`);
console.log(`  correct (allow):              ${allowed}  (${pct(allowed)}%)`);
console.log(`  finding kinds among flagged:`, JSON.stringify(kinds));
if (flagged.length) { console.log(`\n  sample flagged (real legit packages wrongly flagged):`); for (const f of flagged) console.log(`    - ${f}`); }
