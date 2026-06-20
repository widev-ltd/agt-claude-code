// catch-malicious.mjs — INDEPENDENT catch measurement for the plugin's OFFLINE
// NAME heuristic (typosquat / denylist / non-registry) over REAL malicious package
// names from OpenSSF's human-vetted malicious-packages dataset (NOT authored here).
//
// HONEST SCOPE: this measures ONLY the cheap, offline, name-based runtime check. It
// is NOT the plugin's malware defense — most real malware uses original campaign
// names (not typosquats of popular packages), and is removed from the registry, so
// it cannot be transitively resolved/scanned here. The Tier-2 CVE/malware scanner
// (osv-scanner consumes this same OSSF feed) is the real detection layer and is
// measured in the live track. Expect a LOW number — and read it as "what the name
// heuristic alone catches," not "what the plugin catches."
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(here, "..", "..", "plugins", "agt-governance", "scripts");
const deps = await import(pathToFileURL(join(ENGINE, "deps.mjs")).href);

const data = JSON.parse(readFileSync(join(here, "data", "malicious-ossf.json"), "utf8"));
const defPol = JSON.parse(readFileSync(join(ENGINE, "..", "config", "default-policy.json"), "utf8"));
const policy = deps.compileDepsPolicy(defPol.dependencyPolicies ?? { mode: "enforce" });

function measure(eco, ecoKey, list) {
  let caught = 0; const kinds = {}; const hits = [];
  for (const name of list) {
    const spec = { ecosystem: ecoKey, name, spec: name }; // unpinned name (as an attacker would reference it)
    const findings = deps.scanDependencyMetadata([spec], policy);
    const d = deps.depsDecision(findings, policy);
    if (d && (d.decision === "deny" || d.decision === "review")) {
      caught++;
      for (const f of findings) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
      if (hits.length < 20) hits.push(`${name} → ${d.decision} (${findings.map((f) => f.kind).join(",")})`);
    }
  }
  const pct = ((100 * caught) / list.length).toFixed(2);
  console.log(`\n${eco}: name-heuristic caught ${caught}/${list.length} (${pct}%) of REAL malicious names`);
  console.log(`  kinds:`, JSON.stringify(kinds));
  for (const h of hits) console.log(`    - ${h}`);
}

console.log("INDEPENDENT catch — plugin OFFLINE name heuristic over REAL OSSF malicious names");
console.log("source:", data.source);
console.log("policy: shipped default dependencyPolicies (enforce)");
measure("PyPI", "pypi", data.pypi);
measure("npm", "npm", data.npm);
console.log("\n(LOW is expected and honest: most real malware uses original names, not typosquats of");
console.log(" popular packages. The name check is one cheap signal; the CVE/malware SCANNER — osv-scanner,");
console.log(" which consumes this same OSSF feed — is the real detection layer, measured in the live track.)");
