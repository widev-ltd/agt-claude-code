// run-selftests.mjs — run every selftest-*.mjs in this directory and report.
// Exits non-zero if any selftest fails. Run: node run-selftests.mjs

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(HERE).filter((f) => /^selftest-.*\.mjs$/.test(f)).sort();

const failed = [];
for (const t of tests) {
  const r = spawnSync(process.execPath, [join(HERE, t)], { encoding: "utf8" });
  const passed = r.status === 0;
  const last = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  console.log(`${passed ? "PASS" : "FAIL"}  ${t.padEnd(32)} ${last}`);
  if (!passed) {
    failed.push(t);
    if (r.stderr) console.log(r.stderr.trim());
  }
}

console.log(
  `\n${failed.length === 0 ? `ALL ${tests.length} SELFTESTS PASS` : `${failed.length} FAILED: ${failed.join(", ")}`}`,
);

// ── Final step: shared-engine parity ─────────────────────────────────────────
// After the selftests, also verify the 11 shared modules are byte-identical
// across the canonical dir, the gitignored mirror, and the OC plugin source.
// parity-check.mjs resolves its own paths from its file location, so this works
// regardless of the cwd `run-selftests.mjs` was launched from. Parity failure is
// reported as a SEPARATE concern (not folded into the selftest tally) and on its
// own causes a non-zero exit.
const parity = spawnSync(process.execPath, [join(HERE, "parity-check.mjs")], { encoding: "utf8" });
const parityOk = parity.status === 0;
console.log("\n----- shared-engine parity -----");
if (parity.stdout) process.stdout.write(parity.stdout);
if (!parityOk && parity.stderr) process.stderr.write(parity.stderr);
console.log(
  parityOk
    ? "PARITY CHECK: PASS"
    : "PARITY CHECK: FAIL — shared modules drifted across copies (see table above; run `node sync-shared.mjs`).",
);

// Exit non-zero if EITHER the selftests OR the parity check failed.
process.exit(failed.length === 0 && parityOk ? 0 : 1);
