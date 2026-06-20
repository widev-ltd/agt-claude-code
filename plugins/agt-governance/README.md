# agt-governance

Runtime **governance for Claude Code**, powered by Microsoft's
[Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit)
(AGT). The plugin evaluates every tool call, user prompt, and tool result
against a policy *before/after* it is used, and records decisions to a
tamper-evident audit log.

The AGT SDK is **vendored inside the plugin** — installation needs no `npm`.

## What it does

Wired into four Claude Code hooks via [hooks/hooks.json](hooks/hooks.json):

| Hook | What AGT does |
| --- | --- |
| `PreToolUse` | Allow / `ask` / **deny** each tool call. Blocks `rm -rf`, `curl\|sh` bootstraps, credential-file reads, cloud-metadata access; runs the context-poisoning detector over `mcp__*` tool arguments and scans every call for MCP tool-poisoning and typosquatting. |
| `PostToolUse` | Scans tool output (web fetches, shell output) for prompt-injection / exfiltration cues and warns the model that flagged output is untrusted. |
| `UserPromptSubmit` | Scans the prompt for injection / context-poisoning; injects a standing guardrail context. Blocks prompts that look like injection attempts. |
| `SessionStart` | Loads the policy and reports governance status. |

All decisions are appended to a **hash-chained** audit log — each entry stores a
SHA-256 of its contents plus the previous entry's hash, so the chain can be
verified for tampering. The chain accumulates across hook invocations and
persists across plugin updates (written atomically — temp file + rename — so a
torn write cannot truncate the log). Note it is tamper-**evident**, not
tamper-**proof**: the chain is keyless and computed over public fields, so
anyone who can write the log file can recompute a valid chain. Treat it as an
integrity tripwire; forward entries to an append-only sink (SIEM/WORM) for true
non-repudiation.

## Governance extensions

Beyond the four core hooks, the policy enables six additional layers (configure
each in `default-policy.json`; `mode: "advisory"` warns, `mode: "enforce"` blocks):

| Extension | Default | What it does |
| --- | --- | --- |
| **DLP** (`dlpPolicies`) | advisory | Scans tool output / WebFetch URLs for credential values (AWS keys, GitHub tokens, private keys) and PII (SSN, credit-card via Luhn, email). Allow-snippets suppress docs placeholders. |
| **Exfiltration** (`exfilPolicies`) | enforce | Session-aware: tracks credential *values* seen in tool output, then blocks an outbound request (WebFetch/curl) that embeds one — the read-secret-then-send-it pattern. |
| **Rate-limit** (`rateLimitPolicies`) | advisory | Per-session, per-tool call budgets (default Bash 150/h, WebFetch 50/h, 500 total). |
| **Content-safety** (`contentSafetyPolicies`) | advisory | Scans tool output for harmful-instruction / jailbreak / credential-social-engineering content; optional external API (e.g. Azure AI Content Safety). |
| **Dependency** (`dependencyPolicies`) | enforce | Deterministic supply-chain hygiene a CVE scanner is blind to — denied package, non-registry/editable source, untrusted index (dependency-confusion), npm install-scripts — across Python (PEP 723 inline, requirements, pyproject) and Node (package.json, lockfiles). The transitive **CVE** scan is delegated to trivy/osv (Tier-2). See below. |
| **Skill** (`skillPolicies`) | enforce | Governs a skill before it runs: integrity attestation, dangerous-pattern / secret / prompt-injection / capability-profile scans, source allowlist, and the **scan-once / verify-cheaply attestation** that drives the transitive CVE gate. See below. |

## Skill & dependency supply-chain governance

Skills are third-party code + third-party dependencies executing inside the agent.
Before a skill runs, this layer resolves its **full transitive dependency tree**
(`uv` for Python incl. PEP 723 inline, `npm` for Node) and CVE-scans it
(**trivy / osv-scanner / pip-audit**), then **stamps** the result so it isn't
re-scanned every run. The stamp is what the gate trusts — and there are **two trust
tiers**, because a stamp the scanned code itself can forge is worthless against a
malicious skill:

- **CI-signed (strong, durable).** A signer *outside the agent's box* (CI / HSM)
  scans the skill and — only if it PASSES — signs the attestation with an Ed25519
  private key the agent machine never holds. The signed attestation ships
  **alongside the skill** (`.agt-attestation.json`, excluded from the integrity
  hash). The plugin **verifies** it with the trusted **public key**, which is
  *delivered out of band* and configured in `skillPolicies.trustedSigners` (a PEM
  or a file path — never bundled in the plugin). A local attacker cannot forge this:
  they lack the private key. **A signature IS the pass — CI never signs a failing
  skill**, so the gate does not re-judge a signed stamp.
- **Local 1-day grace (weak, default).** A skill with no valid CI signature is
  **scanned locally on first use**; if it passes, it gets a stamp valid for **1
  day**, so it's usable for a day, then must be re-scanned (or CI-signed). This tier
  is **forgeable but time-boxed** — a local writer could plant a 1-day stamp; the
  expiry caps the exposure. Set `skillPolicies.requireSignature: true` for **strict
  mode**, which drops this tier entirely (only CI-signed skills run).

**The CI signer is a SEPARATE tool, run by CI — never installed on the agent box:**

```bash
# in CI, with the PRIVATE key that never touches an agent machine:
node tools/skill-signer/sign.mjs <skill-dir> --key <ci-private.pem> [--threshold high]
#   PASS → writes <skill-dir>/.agt-attestation.json (exit 0)
#   FAIL (CVE ≥ threshold) → NOT signed (exit 1) — there is no signed-but-vulnerable
```

For local/dev use without CI, the proactive audit produces the 1-day local stamp
ahead of time (so the first real use is a cache hit, not an inline scan):

```bash
node scripts/skills-audit.mjs <skill-dir> [<skill-dir> ...] [--scanner trivy|osv-scanner|pip-audit]
```

**Fail-safe behavior (not a guarantee — a guardrail).** A skill is allowed silently
**only** when its deps were actually resolved transitively **and** scanned clean (or
carry a valid CI signature). If they can't be (no resolver/scanner installed, a
resolver error, an unresolvable inline form, a bare-import `.js` with no manifest),
coverage is **`unavailable`** → **unverified = unsafe** (review/deny). It is never
stamped clean on an unscanned set — no false-clean. **What this does NOT do:** the
scan catches *known* CVEs + *known* patterns (not novel/zero-day); the local 1-day
tier is forgeable; and a skill that runs once with your privileges can subvert the
local guard. The CI-signed tier is the only one resistant to a local forger; for a
true boundary you need OS-level isolation, which this is not. Methodology + measured
numbers: [`experiment/supplychain/BENCHMARK.md`](../../experiment/supplychain/BENCHMARK.md)
(a self-graded regression suite, not an independent benchmark — see its header).

**Session state & the per-event process model.** Claude Code runs each hook as a
**fresh process**, so the stateful extensions (exfil, rate-limit) persist their
per-session state to disk under the plugin data dir (`CLAUDE_PLUGIN_DATA` or
`~/.claude/agt/sessions/`), keyed by a hashed session id, written atomically.
Exfil stores one file per tracked secret (conflict-free under concurrency); a
session in active use is kept alive against the 24h eviction. On OpenCode the
plugin is resident and uses in-memory state — same source, runtime-selected.

**Known limitations of the content layers (defense-in-depth, not guarantees).**
These detectors are heuristic and meant to be layered with native settings, not
relied on alone:

- **Exfil matching is a tripwire, not a robust egress DLP.** It catches a tracked
  secret reused *verbatim* in an outbound request; byte transforms (base64/hex/
  splitting) evade the substring match. It raises the bar against casual/accidental
  exfil — pair it with the egress allowlist for real containment.
- **DLP / content-safety pattern catalogues are not exhaustive.** DLP focuses on
  common cloud/VCS credentials + PII; it will miss provider tokens it has no
  pattern for (JWT, Slack/Stripe/etc.). Content-safety heuristics are defeatable by
  paraphrase / unicode. Extend both via `customPatterns` in the policy.
- The detectors default to **advisory** (warn) precisely because heuristic matching
  has false positives/negatives; switch a layer to `enforce` once you've validated
  its behavior on your workload.

## Project-policy trust gate

A project may ship `.claude/agt-policy.json` to **tighten** governance. By
default such a project-local policy is **untrusted**: it may only ADD
restrictions — it can never weaken the global/default policy (cannot switch
`enforce`→`advisory`, allow-all tools, disable an extension, or carve an
allow-hole over a credential path). A hostile repository therefore cannot
neuter governance by committing a permissive policy. To use a project policy
verbatim, grant trust explicitly via `AGT_TRUST_PROJECT_POLICY=1` or by listing
the project path in `~/.claude/agt/trusted-projects.json` (a user-domain file a
repo cannot write). Clamped downgrade attempts are recorded in the audit log.

## Install

```text
/plugin marketplace add widev-ltd/agt-claude-code
/plugin install agt-governance@agt-governance-marketplace
```

Then restart Claude Code (or run `/reload-plugins`).

**Requirements:** Node.js 18+ on `PATH` (Claude Code already ships Node).

## Configuration

A policy has two independent parts; understanding the split is the key to
configuring the plugin:

1. **Tool tiers** (`toolPolicies`) — the **friction dial**. A tool is `allowed`
   (runs), reviewed (→ an **interactive approval prompt**), or blocked. *Most
   day-to-day friction comes from here* — a broad review tier prompts on benign
   `Bash`/`Edit`/`WebFetch`.
2. **Threat rules** (`blockedToolCalls`, `directResourcePolicies`,
   `poisoningPatterns`) + the **extensions** — the **security**. These fire on
   the specific dangerous pattern (`rm -rf`, credential reads, metadata SSRF,
   `curl|sh`, prompt injection) regardless of the tier, near-zero false
   positives. A threat-rule `deny` always wins over an allowed tier.

So you can keep strong security **without** the prompting: widen `allowedTools`
(or pick `secure-low-friction`) and the threat rules still block dangerous calls.

### Policy profiles

The bundled [config/default-policy.json](config/default-policy.json) is the
`balanced` profile. Four profiles ship in [config/profiles/](config/profiles) —
all carry the **same** threat rules + extensions, differing only in tool tiers /
mode:

- **`strict`** — only the read-family is allowed; shell/edit/web/task are
  reviewed (and persistence-oriented writes denied). Lock-down.
- **`balanced`** *(default)* — read-family allowed; `Bash`/`Edit`/`Write`/`Web…`
  reviewed (interactive approval). Safe, but prompts on benign shell/edit.
- **`secure-low-friction`** — **recommended when you want security without
  blocking work.** Allows the everyday tools (`Bash`/`Edit`/`Write`/`WebFetch`/…);
  only subagent spawning (`Task`) is reviewed. The named threat rules + exfil/DLP/
  content-safety still enforce, so dangerous calls are still blocked — you just
  drop the blanket "approve everything" prompting.
- **`advisory`** — explicit hard rules still block (`rm -rf`, secret reads) while
  heuristic detections only **warn**. Lowest friction; good for first rollout.

The default (balanced) is used unless you override it. **Profiles are not
auto-selected** — activate a different one by copying it to a policy path below.

### Custom / per-project policy

Drop a policy JSON at either location and the plugin uses it instead of the
bundled default (first match wins):

- `<project>/.claude/agt-policy.json` — per project
- `<CLAUDE_PLUGIN_DATA>/policy.json` — per user

For example, to run the low-friction profile for a project:
`cp config/profiles/secure-low-friction.json <project>/.claude/agt-policy.json`.
Copy any profile as a starting point and edit it. If a custom policy fails to
load, the plugin **fails closed** (denies tool calls) by design.

> **A project-local `.claude/agt-policy.json` is UNTRUSTED by default** — it may
> only *add* restrictions, never weaken the global/default policy (see
> [Project-policy trust gate](#project-policy-trust-gate) above). To use one
> verbatim, grant trust via `AGT_TRUST_PROJECT_POLICY=1` or the
> `trusted-projects.json` allowlist. A per-*user* policy at
> `<CLAUDE_PLUGIN_DATA>/policy.json` is trusted (it's in your own data dir).

### Skill & dependency policy keys

Both supply-chain extensions take a `mode` (`advisory` warns / `enforce` blocks)
and merge over the shipped defaults. The useful knobs (verified field names):

```jsonc
"dependencyPolicies": {
  "mode": "enforce",
  "deny": ["evil-pkg"],                  // package names always denied
  "severityThreshold": "medium",         // min severity that escalates
  "allowedIndexes": ["https://pypi.org/simple"]   // [] = any index OK
}
"skillPolicies": {
  "mode": "enforce",
  "allowedSources": ["https://trusted-marketplace.example/"],  // origin allowlist ([] = any)
  "capabilityProfile": {                 // operator budget — the HARD ceiling (false = forbid)
    "maxNetwork": true, "maxSubprocess": true, "maxFsWrite": false, "maxSecretRead": false
  },
  "severityThreshold": "high",           // min finding severity that escalates (default high)
  "maxAgeMs": 604800000                  // attestation re-audit window (default 7 days)
}
```

**Capability least-privilege.** A skill declares what it may do in its `SKILL.md`
frontmatter — `allowed-capabilities: [network, subprocess, fs-write, secrets]`
(aliases accepted; flow-list or block-list form). A capability **used but not
declared** — or declared but forbidden by the operator `capabilityProfile` budget
— is flagged. The budget is the hard ceiling: a self-declaration can never grant a
capability the operator set to `false`. This is the control behind the benchmark's
100% skill-capability score (see `experiment/supplychain/BENCHMARK.md`).

### Audit log

Written to `${CLAUDE_PLUGIN_DATA}/audit-log.json` (falls back to
`~/.claude/agt/audit-log.json`). It survives plugin updates.

## Tool-name tuning

AGT's policy engine is shared with the AGT Copilot CLI integration; this plugin
ships a policy retargeted to Claude Code tool names — `Bash`, `PowerShell`,
`Edit`, `Write`, `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`,
`NotebookEdit`, `Task`. MCP tools (`mcp__*`) need no policy entry: every tool
call is scanned by the MCP threat backend automatically.

Claude Code's shell tool is named `Bash` on every platform; the `PowerShell`
tool only exists behind the opt-in `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`. So the
shell command rules are duplicated for both the `Bash` and `PowerShell` tools
and each carries **both** Unix and PowerShell command patterns, so dangerous
commands are caught regardless of platform or which shell tool is active.

## Known limitations

- **In-process guardrail, not a sandbox** — like AGT upstream, enforcement runs
  in the same trust/process boundary as the agent it governs (a Claude Code hook
  process). It reliably gates well-behaved tool calls, but code that can escape
  the agent process or the hook can bypass it. For hard isolation, run Claude
  Code (and the agent) inside a container or VM. See the AGT
  [Architecture — Security Boundaries](https://github.com/microsoft/agent-governance-toolkit/blob/main/docs/ARCHITECTURE.md).
- **Per-call cost** — Claude Code runs hooks as a fresh process per event, so
  the policy engine is rebuilt each call. Functionally fine; adds minor latency.
- **Tool output cannot be retracted** — Claude Code hooks cannot un-send a tool
  result, so flagged output is downgraded to a strong untrusted-data warning
  rather than being suppressed.
- **Prompt rewriting** — AGT may want to rewrite a suspicious prompt; Claude
  Code cannot, so such prompts are blocked instead.
- The AGT SDK is **Public Preview** — see [NOTICE](NOTICE).

## Building from source (maintainers)

The vendored SDK under `vendor/` is produced by
[`scripts/build-vendor.mjs`](../../scripts/build-vendor.mjs) at the repo root.
See the repository README for the build steps.

## Licensing

Plugin code is MIT ([LICENSE](LICENSE)). It vendors and adapts MIT-licensed
components of Microsoft's Agent Governance Toolkit — see [NOTICE](NOTICE).
