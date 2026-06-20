// forge.mjs <skillDir> <mode> [baseAttFile] — play the LOCAL ATTACKER (running with
// the user's privileges). Tries to plant a "clean" stamp the gate would accept.
//   mode=unsigned : a clean record with NO signature
//   mode=attacker : a clean record signed with the ATTACKER's own key (not CI's)
//   mode=tamper   : take a real CI-signed stamp, flip findings to [] , keep the old sig
// Writes .attestations/forged.json. The gate must REJECT all three.
import { sign, createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, "..", "..", "plugins", "agt-governance", "scripts");
const [skillDir, mode, baseAttFile] = process.argv.slice(2);
const skills = await import(pathToFileURL(join(scripts, "skills.mjs")).href);
const att = await import(pathToFileURL(join(scripts, "attestation.mjs")).href);

function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

const key = att.skillIntegrityKey(skills.skillFileHashesSync(skillDir));
let record;
if (mode === "tamper") {
  record = JSON.parse(readFileSync(baseAttFile, "utf8"));
  record.rawFindings = []; // pretend it's clean, keep the original signature
} else {
  record = {
    schema: 1, key, basis: "scanned", scanCoverage: "transitive",
    rawFindings: [], scannerName: "trivy", vulnDbVersion: null,
    timestampMs: 1750000000000, policySnapshot: { mode: "enforce" },
  };
  if (mode === "attacker") {
    const { sig, signer, ...signed } = record;
    const aPriv = createPrivateKey(readFileSync(join(here, ".keys", "attacker-private.pem")));
    record.sig = sign(null, Buffer.from(canon(signed), "utf8"), aPriv).toString("base64");
    record.signer = "attacker";
  }
}
mkdirSync(join(here, ".attestations"), { recursive: true });
const out = join(here, ".attestations", "forged.json");
writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
console.log(`attacker wrote forged stamp (mode=${mode}) -> ${out}`);
