# Independent measurement — plugin detectors vs. data this project did NOT author

Unlike `experiment/supplychain/` (a self-graded regression suite: our cases, our
scorer), this track measures the shipped detectors against **external, real-world
data**. External sources:

- **Real vulnerable releases** (PyPI + npm) at versions with known CVEs.
- **Benign population:** [hugovk/top-pypi-packages](https://hugovk.dev/top-pypi-packages/)
  (external download ranking) — every entry is a real legit package.
- **Malicious names:** [ossf/malicious-packages](https://github.com/ossf/malicious-packages)
  (human-vetted real malware names).

All run through the **shipped default `dependencyPolicies`** (enforce). Data under
`data/` with provenance.

## 1. CVE coverage — THE GOAL (`cve-coverage.mjs`)

The supply-chain layer's purpose is to catch dependency versions with known CVEs,
**transitively**, and gate on them. Detection itself is the **external scanner's**
(trivy/osv — known-CVE recall is the scanner's property). The plugin's *measurable
value* is (1) resolving the **full transitive tree** so indirect CVEs are seen, and
(2) gating. The number that captures (1) is the **transitive vs. declared split**:

| Real vulnerable release | CVEs caught | declared (direct) | **transitive (indirect)** |
|---|---:|---:|---:|
| `requests==2.19.0` | 18 | 5 | **13** (urllib3, idna) |
| `express@4.16.0` | 11 | 2 | **9** (qs, body-parser, send, …) |
| `django==2.2` | 35 | 35 | 0 |
| `jinja2==2.10` | 6 | 6 | 0 |
| `pyyaml==5.1` | 3 | 3 | 0 |
| `flask==1.0` | 2 | 2 | 0 |
| **Total** | **75** | 53 | **22 (29%)** |

So **29% of caught CVEs in this set are in indirect dependencies a manifest-only
scan would miss** — and for app-style packages it dominates (requests 13/18,
express 9/11). That is the plugin's real contribution over a shallow check.

**Honest caveats:** this 6-release set is **illustrative** (chosen because they have
known CVEs), not a representative random sample — so "29% transitive" shows the
*value*, not a population rate. Detection = the scanner's **known-CVE** recall
(zero-day is out of reach for any scanner). Current *latest* popular packages are
mostly clean (low CVE prevalence) — that's the false-positive side, below.

## 2. False-positive rate — real top PyPI packages (`fp-popular.mjs 5000`)

| Population | Hard-deny (FPR) | Review (friction) | Correct |
|---|---:|---:|---:|
| Top **5000** real PyPI packages | **0.00 %** (0) | 0 % | 100.00 % |

This measurement is what got the **typosquat detector cut entirely**. It originally
found 5 false positives — real, widely-used packages flagged as typosquats because
they sit 1 edit from a popular name (`scapy`↔scipy, `pyaml`↔pyyaml,
`tensorflowjs`↔tensorflow, `httpr`↔httpx, `dydantic`↔pydantic). The first attempt
was a hardcoded `LEGIT_NAMES` allowlist — a band-aid (whack-a-mole, goes stale).
The right call, made instead: **remove name-distance typosquat detection** (an
FP-prone heuristic that reinvents the scanner/registry ecosystem's job), along with
`unpinned` (the lockfile's job) and `license-deny` (compliance, not security). The
remaining **deterministic** checks (denied / non-registry / untrusted-index /
install-script) produce **0 false positives** over 5000 real packages — as expected,
since they're deterministic, not heuristic.

## 3. Why typosquat/malware-name detection was cut (not just tuned)

`catch-malicious.mjs` *before the cut* showed the offline name check catching only
**2.6% (PyPI) / 0% (npm)** of real OSSF malware names — structurally, a name check
only catches typosquats of popular packages, and most real malware uses original
campaign names. **After the cut the check is gone, so it now catches 0% / 0% by
construction** — running `catch-malicious.mjs` against the shipped code reports 0/0.
That 2.6% was the high-water mark of a heuristic not worth keeping. Two findings
sealed the decision to cut it:

- **The scanner ecosystem doesn't reliably do it either.** osv-scanner flagged a
  CVE package (`requests@2.19.0` → 7 advisories) but **not** famous historical
  malware (`jeIlyfish`/`colourama`/`python3-dateutil`) — OSV has **zero** advisories
  for them. So neither a hand-rolled heuristic nor the scanner closes the
  malware-name gap; it's an industry-wide hard problem.
- **A "100%" osv.dev result I ran and THREW OUT for circularity** — those OSSF names
  *come from* the OSV feed, so querying OSV for them proves nothing. Recorded so the
  mistake isn't repeated. A real malware-catch number needs a **time-split** (freeze
  the DB at T, test on malware first published after T) — not built.

Conclusion: a name heuristic is the wrong tool; the **scanner is the real (if
incomplete) malware/CVE layer**, and a bespoke detector would reinvent it badly.

## What this establishes (and what it doesn't)

- **The goal (CVE catch) is real and transitive-aware** — 75 real CVEs, 29% in
  indirect deps; detection is the external scanner's, the plugin adds transitive
  resolution + gating. This is what the supply-chain layer is *for*.
- **FP on real data: 0%** over 5000 packages — after cutting the FP-prone typosquat
  heuristic; the remaining checks are deterministic.
- **Typosquat/unpinned/license detectors were CUT** (over-engineering / lockfile's
  job / compliance) — this measurement drove that decision.
- **Still owed:** a representative (not illustrative) CVE corpus; a measured
  host-platform baseline; the time-split malware test.

## Reproduce

```bash
cd experiment/independent              # needs uv/npm + trivy on PATH, and network
node cve-coverage.mjs A                # transitive vs. declared CVE split (the goal)
node fp-popular.mjs 5000               # FP over real top PyPI packages
node catch-malicious.mjs              # name-heuristic catch (thin signal)
```
