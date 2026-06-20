// verify.mjs <skillDir> <attestationFile> — SIMULATE the LOCAL gate. It holds ONLY
// the CI PUBLIC key. It (1) re-binds the stamp to the skill's CURRENT files, (2)
// verifies the Ed25519 signature against the trusted CI public key, (3) checks
// freshness, then (4) reuses the REAL decideFromFindings. A stamp that does not
// verify under the CI public key is REJECTED — a local attacker cannot forge it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, "..", "..", "plugins", "agt-governance", "scripts");
const [skillDir, attFile] = process.argv.slice(2);
if (!skillDir || !attFile) { console.error("usage: verify.mjs <skillDir> <attestationFile>"); process.exit(2); }

const skills = await import(pathToFileURL(join(scripts, "skills.mjs")).href);
const att = await import(pathToFileURL(join(scripts, "attestation.mjs")).href);
const pol = await import(pathToFileURL(join(scripts, "policy.mjs")).href);

const REJECT = (why) => { console.log(`VERDICT: REJECT (re-scan / block) — ${why}`); process.exit(0); };

// The skill's CURRENT identity (binds the stamp to exact file contents).
const integrityKey = att.skillIntegrityKey(skills.skillFileHashesSync(skillDir));
let record;
try { record = JSON.parse(readFileSync(attFile, "utf8")); } catch { REJECT("attestation unreadable"); }

// (1) Binding: the stamp must be for THESE files.
if (record.key !== integrityKey) REJECT("stamp not bound to the skill's current files (integrity-key mismatch)");

// (2) Signature: must verify against the TRUSTED CI public key, via the SHIPPED
//     verifier (production code path). This is the wall a local attacker cannot
//     climb — they lack the CI private key.
if (!record.sig) REJECT("no signature (unsigned stamp — untrusted)");
const ciPub = readFileSync(join(here, ".keys", "ci-public.pem"), "utf8");
if (!att.verifyAttestationSignature(record, [ciPub])) {
  REJECT("signature does NOT verify against the trusted CI key (forged or tampered)");
}

// (3) Freshness (age + clock-skew). 7-day window.
if (!att.isFresh(record, { maxAgeMs: 7 * 24 * 3600 * 1000 })) REJECT("stamp stale/expired");

// (4) Real decision logic on the verified record.
const compiled = pol.compilePolicy({ skillPolicies: { enabled: true, mode: "enforce" } });
const d = att.decideFromFindings(record, compiled.skill);
const verdict = d.effect === "allow" ? "ALLOW" : d.effect === "deny" ? "DENY" : "REVIEW";
console.log(`VERDICT: ${verdict} — ${d.reason}`);
console.log(`  (signature OK, signer=${signer}, coverage=${record.scanCoverage}, findings=${(record.rawFindings ?? []).length})`);
