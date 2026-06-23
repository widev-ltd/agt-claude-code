# Configuration — agt-governance for Claude Code

## Policy resolution order

The plugin uses the **first** of these that exists, falling back to the bundled
default:

1. `<project>/.claude/agt-policy.json` — per project
2. `${CLAUDE_PLUGIN_DATA}/policy.json` — per user (falls back to
   `~/.claude/agt/policy.json`)
3. bundled `config/default-policy.json` — the `balanced` default

If a custom policy fails to load, the plugin **fails closed** (denies tool calls)
by design.

## Switching profile

Profiles are **not auto-selected** — activate one by copying it over a policy
path. For example, to run `strict` for a single project:

```bash
cp plugins/agt-governance/config/profiles/strict.json \
   <project>/.claude/agt-policy.json
```

Or per user (applies everywhere unless a project overrides it):

```bash
cp plugins/agt-governance/config/profiles/balanced.json \
   "${CLAUDE_PLUGIN_DATA:-$HOME/.claude/agt}/policy.json"
```

Restart the session (or `/reload-plugins`) after changing the policy.

### What the profiles differ on

Four profiles ship in `config/profiles/`. They carry the **same** threat rules +
extensions and differ only in the tool tiers / mode:

- **strict** — only the read-family is allowed; shell / edit / web / task are
  reviewed, and persistence-oriented writes (`.bashrc`, git hooks, `tasks.json`,
  …) are **denied**; heuristics enforced. Lock-down.
- **balanced** *(default)* — read-family allowed; `Bash`/`Edit`/`Write`/`Web…`/
  `Task`/`NotebookEdit` reviewed (interactive approval); those persistence writes
  are **reviewed** instead of denied. Safe, but prompts on benign shell/edit.
- **secure-low-friction** — **recommended when you want security without
  blocking work.** Allows the everyday tools (`Bash`/`Edit`/`Write`/`WebFetch`/…);
  only subagent spawning (`Task`) is reviewed. The named threat rules + exfil/
  DLP/content-safety still enforce, so dangerous calls are still blocked — you
  just drop the blanket "approve everything" prompting.
- **advisory** — same tool split as balanced but in advisory mode: explicit hard
  rules (`rm -rf`, secret reads) still block, while heuristic detections
  (prompt-injection, poisoning, MCP scan) only **warn**. Lowest friction — good
  for first rollout.

Activate `secure-low-friction` like any other profile — e.g.
`cp plugins/agt-governance/config/profiles/secure-low-friction.json <project>/.claude/agt-policy.json`.

## Policy file shape

A policy is a JSON document (`schemaVersion: 1`). Key fields:

```jsonc
{
  "schemaVersion": 1,
  "version": 1,
  "profile": "balanced",
  "mode": "enforce",                  // "enforce" | "advisory"
  "denyOnPolicyError": true,          // fail closed if evaluation errors
  "minimumPromptDefenseGrade": "B",   // reported in status (informational, not a gate)
  "toolPolicies": {
    "allowedTools": ["Read", "Glob", "Grep", "TodoWrite"],
    "reviewTools":  ["Bash", "PowerShell", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task"],
    "blockedTools": [],
    "defaultEffect": "review"
  },
  "outputPolicies": {
    "suppressTools": ["WebFetch", "WebSearch"],
    "advisoryTools": ["Bash", "PowerShell"]
  },
  "scanOutputTools": ["WebFetch", "WebSearch", "Bash", "PowerShell"],
  "blockedToolCalls": [ /* command-pattern rules per tool: recursive-delete, dangerous-bootstrap, secret-read, persistence-write */ ],
  "directResourcePolicies": { "pathRules": [ /* credential paths */ ], "urlRules": [ /* metadata endpoints */ ] },
  "poisoningPatterns": [ /* prompt/output injection regexes */ ],
  "additionalContext": [ /* guardrail lines injected on UserPromptSubmit */ ]
}
```

- **Tool names** are matched case-insensitively; anything unlisted uses
  `defaultEffect`.
- **`blockedToolCalls`** are per-tool regex command patterns with an effect. The
  shipped rules are duplicated for `Bash` and `PowerShell` and cover recursive
  deletes, downloaded-script bootstraps, credential/secret reads, and persistence
  writes — across Unix *and* PowerShell syntaxes.
- **`directResourcePolicies`** deny reads of credential *paths* (`.ssh`, `.env`,
  `.aws`, …) and access to cloud-metadata URLs regardless of the command text.
- **`poisoningPatterns`** flag prompt-injection / context-poisoning in prompts and
  tool output.

Copy any profile as a starting point and edit it. Keep `denyOnPolicyError: true`
so a malformed edit fails safe.

> **Note on `minimumPromptDefenseGrade`:** reported in status but **not** an
> enforcement gate (it grades the built-in guard prose, not your input). Treat as
> informational.

## Governance extensions

Beyond the core policy, the shipped `default-policy.json` enables additional
layers, each with its own `mode` (`advisory` warns, `enforce` blocks). The
content layers (DLP, content-safety, rate-limit) default to **advisory**
(heuristic matching has false positives/negatives — validate on your workload
before enforcing); the structural supply-chain and exfil layers default to
**enforce**.

| Extension | Key | Default | What it does |
|---|---|---|---|
| DLP | `dlpPolicies` | advisory | Credential values (AWS/GitHub/private-key) + PII (SSN, Luhn card, email) in tool output / WebFetch URLs. |
| Exfiltration | `exfilPolicies` | enforce | Session-aware: blocks an outbound request embedding a credential value seen earlier in tool output. |
| Rate-limit | `rateLimitPolicies` | advisory | Per-session, per-tool call budgets. |
| Content-safety | `contentSafetyPolicies` | advisory | Harmful-instruction / jailbreak / credential-social-engineering scan; optional external API. |
| Intent judge | `intentJudgePolicies` | **disabled** | Optional LLM-as-judge for tool-call *intent* (benign/suspicious/malicious). Additive-only, fail-safe to the deterministic verdict. Off by default — see [LLM-JUDGE.md](LLM-JUDGE.md). |
| Dependency | `dependencyPolicies` | enforce | Supply-chain hygiene over a skill's / install command's deps — see below. |
| Skill | `skillPolicies` | enforce | Gates a skill before it runs: integrity attestation + scans — see below. |

### Skill & dependency supply-chain governance

These two are the supply-chain gate. They work in **two tiers** (methodology +
measured numbers in
[`../experiment/supplychain/BENCHMARK.md`](../experiment/supplychain/BENCHMARK.md)
— a self-graded regression suite, not an independent benchmark):

- **Tier 1 (runtime, in-process, no network, on the tool-call path).**
  `dependencyPolicies` parses a skill's manifests — Python `requirements.txt` /
  `pyproject.toml` / **PEP 723 inline metadata**, and Node `package.json` /
  lockfiles — and applies deterministic hygiene a CVE scanner is blind to:
  denied package, non-registry / editable install, untrusted index
  (dependency-confusion), npm install-scripts. `skillPolicies` adds
  metadata-hygiene, dangerous-pattern / secret / prompt-injection /
  capability-profile scans, a source allowlist, and an **attestation lookup**.
- **Tier 2 (off the hot path).** Resolves the **full transitive tree** (`uv` /
  `npm`) and runs an auto-detected CVE scanner (`trivy` / `osv-scanner` /
  `pip-audit`), then writes an attestation so a later runtime gate is a cheap
  cache hit. Claude Code has **no `skills audit` CLI verb** — run the script
  directly:
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/skills-audit.mjs <skill-dir> [<skill-dir> …] [--scanner trivy|osv-scanner|pip-audit]`.
  See [USAGE.md](USAGE.md#trusting-skills--two-tiers).

Useful keys (both accept `mode` and merge over the shipped defaults — verified
field names):

```jsonc
"dependencyPolicies": {
  "mode": "enforce",
  "deny": ["evil-pkg"],                  // package names always denied
  "severityThreshold": "high",           // min severity that escalates to deny (default high)
  "allowedIndexes": ["https://pypi.org/simple"]  // [] = any index OK
}
"skillPolicies": {
  "mode": "enforce",
  "blockSecrets": true,                  // deny on secret/credential material in the skill
  "blockInjection": true,                // deny on prompt-injection cues in the skill
  "allowedSources": ["https://trusted-marketplace.example/"],  // skill origin allowlist ([] = any)
  "capabilityProfile": {                 // operator budget — the HARD ceiling (false = forbid)
    "maxNetwork": true, "maxSubprocess": true,
    "maxFsWrite": false, "maxSecretRead": false
  },
  "severityThreshold": "high",           // min finding severity that escalates (default high)
  "trustedSigners": ["/etc/agt/ci-public.pem"]  // CI public key(s): PEM or file path (delivered out of band)
}
```

> **Two trust tiers.** A **CI-signed** stamp — verified against `trustedSigners`,
> a public key you deliver out of band — is unforgeable by a local attacker
> because the private key lives in CI/HSM, off the agent box. A signature **is**
> the pass: CI signs only skills that scanned clean, so the gate does not re-judge
> a signed stamp. An **unsigned** skill falls back to a **local, time-boxed
> stamp** written on first use (forgeable). The CI signer is a **separate tool**
> run by CI, never on an agent box — see
> [`../tools/skill-signer/README.md`](../tools/skill-signer/README.md). For the
> first-use approval flow (`user-approved` cert) and how it relates to the local
> tier, see [USAGE.md](USAGE.md#trusting-skills--two-tiers).
>
> *Configuration knobs related to the durable tier — e.g.
> `skillPolicies.requireSignature` (strict, CI-signed-only) and the exact stamp
> lifetimes — are landing in a parallel change and are intentionally **not**
> documented as shipped here; configure them from the signer README / policy
> `_note` once that change settles.*

> **Capability least-privilege.** A skill declares what it may do in its
> `SKILL.md` frontmatter (`allowed-capabilities: [network, subprocess, …]`). A
> capability **used but not declared** — or declared but forbidden by the operator
> `capabilityProfile` budget — is flagged. The budget is the hard ceiling: a
> self-declaration can never override a capability the operator set to `false`.

> **Fail-safe behavior (a guardrail, not a guarantee).** In `enforce`, a skill is
> silent-allowed only when its deps were actually resolved transitively **and**
> scanned clean (or carry a valid CI signature). If they can't be (no
> resolver/scanner, resolver error, bare-import JS with no manifest) coverage is
> `unavailable` → unverified = unsafe (review/deny), never a false-clean. It
> catches *known* CVEs/patterns (CVE detection delegated to trivy/osv), not
> novel/zero-day; only the CI-signed tier resists a local forger; a true boundary
> needs OS-level isolation, which this is not.

### Intent judge (optional LLM-as-judge — off by default)

`intentJudgePolicies` is an opt-in layer that asks an LLM to assess the **intent**
of a tool call (benign / suspicious / malicious) and feeds that verdict into the
decision. It is **disabled by default** (per-call LLM cost + latency,
non-deterministic) and is **additive-only** — it can raise an `allow` to
`review`/`deny` but never downgrades a deterministic `deny`/`review`, and
fail-safes to the deterministic verdict on error/timeout/missing key. See
[LLM-JUDGE.md](LLM-JUDGE.md) for the full key reference, tradeoffs, and honest
limits.

## Environment variables

| Variable | Effect |
|---|---|
| `CLAUDE_PLUGIN_DATA` | Where per-user `policy.json` and `audit-log.json` live (else `~/.claude/agt`). Set by Claude Code. |
| `CLAUDE_PLUGIN_ROOT` | Plugin install root; used by `hooks.json` to locate `agt-hook.mjs`. Set by Claude Code. |
| `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` | Enables the separate `PowerShell` tool (the policy already covers it). |

(The hook bridges internal `AGT_COPILOT_POLICY_PATH` / `AGT_COPILOT_AUDIT_PATH`
variables to the resolved Claude Code paths; you don't set these yourself.)

## Audit log

- Location: `${CLAUDE_PLUGIN_DATA}/audit-log.json` (else `~/.claude/agt/audit-log.json`).
- A persistent SHA-256 hash chain that accumulates across hook invocations and
  survives plugin updates.
- **Tamper-evident, not tamper-proof** (keyless). Forward to a SIEM/WORM sink for
  non-repudiation. See [OVERVIEW.md](OVERVIEW.md#security-model--read-this).
