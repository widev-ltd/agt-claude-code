// ci-sign.mjs <skillDir> — SIMULATE the trusted signer (CI/pipeline/HSM).
// It runs the REAL scan (auditSkillDir → transitive resolve + CVE scan), takes the
// canonical attestation record the plugin already produces, and SIGNS it with the
// CI PRIVATE key (Ed25519). Output: a signed attestation JSON in .attestations/.
// In production this runs OFF the agent's box; here it's a local stand-in.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, "..", "..", "plugins", "agt-governance", "scripts");
const skillDir = process.argv[2];
if (!skillDir) { console.error("usage: ci-sign.mjs <skillDir>"); process.exit(2); }

// auditSkillDir writes its (unsigned) record into the data dir; point it at a temp.
mkdirSync(join(here, ".ci-data"), { recursive: true });
process.env.CLAUDE_PLUGIN_DATA = join(here, ".ci-data");
process.env.AGT_SESSION_STORE = "disk";

const pol = await import(pathToFileURL(join(scripts, "policy.mjs")).href);
const skills = await import(pathToFileURL(join(scripts, "skills.mjs")).href);
const att = await import(pathToFileURL(join(scripts, "attestation.mjs")).href);

const compiled = pol.compilePolicy({
  dependencyPolicies: { enabled: true, mode: "enforce" },
  skillPolicies: { enabled: true, mode: "enforce" },
});

// REAL scan (transitive resolve + CVE scan); auditSkillDir persists the canonical record.
const summary = await skills.auditSkillDir(skillDir, { skillPolicy: compiled.skill, depsPolicy: compiled.deps });
const record = att.readAttestation(summary.key);
if (!record) { console.error("ci-sign: scan produced no record"); process.exit(1); }

// Fail LOUDLY if no real scan happened. A `coverage:"unavailable"` record (no
// resolver/scanner on PATH) carries no findings — signing it would make the demo's
// "tamper" arm vacuous (flipping an already-empty finding list changes nothing the
// signature didn't already cover). A real CI signer must not vouch for an unscanned
// skill, so neither does this demo: it refuses rather than produce a hollow stamp.
if (record.scanCoverage !== "transitive") {
  console.error(`ci-sign: scan coverage is "${record.scanCoverage}", not "transitive" — a real scan did not run (need uv/npm + trivy/osv-scanner/pip-audit on PATH). Refusing to sign an unscanned skill.`);
  process.exit(1);
}

// Sign with the CI PRIVATE key using the SHIPPED signer (production code path).
const signed = att.signAttestationRecord(record, readFileSync(join(here, ".keys", "ci-private.pem"), "utf8"), "ci");

mkdirSync(join(here, ".attestations"), { recursive: true });
const outPath = join(here, ".attestations", `${summary.key}.json`);
writeFileSync(outPath, JSON.stringify(signed, null, 2) + "\n");

const vulns = (record.rawFindings ?? []).length;
console.log(`CI signed: key=${summary.key.slice(0, 16)}…  coverage=${record.scanCoverage}  findings=${vulns}  scanner=${summary.scanner}`);
console.log(`  -> ${outPath}`);
