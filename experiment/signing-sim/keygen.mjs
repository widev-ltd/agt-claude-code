// keygen.mjs — SIMULATE the trust-anchor setup. In reality the PRIVATE key lives
// in CI / an HSM / a signing service the agent's box never sees; only the PUBLIC
// key ships with the plugin. Here we generate an Ed25519 keypair into .keys/.
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const keyDir = join(here, ".keys");
mkdirSync(keyDir, { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
writeFileSync(join(keyDir, "ci-private.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
writeFileSync(join(keyDir, "ci-public.pem"), publicKey.export({ type: "spki", format: "pem" }));
// An ATTACKER's own keypair — they can sign with THIS, but the gate only trusts ci-public.
const attacker = generateKeyPairSync("ed25519");
writeFileSync(join(keyDir, "attacker-private.pem"), attacker.privateKey.export({ type: "pkcs8", format: "pem" }));

console.log("CI keypair written to .keys/");
console.log("  ci-private.pem    = the SIGNER secret (in real life: CI/HSM, never on the agent box)");
console.log("  ci-public.pem     = ships with the plugin; the gate trusts ONLY this key");
console.log("  attacker-private.pem = a local attacker's own key (gate must NOT trust it)");
