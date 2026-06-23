# Usage — agt-governance for Claude Code

Once installed (see [INSTALL.md](INSTALL.md)) and Claude Code is restarted, the
plugin governs every session automatically. There is nothing to invoke per
request. This page covers what you'll see and how to operate it.

## What happens during a session

The plugin acts on four hooks:

- **Tool calls (`PreToolUse`)** — each call is evaluated:
  - **Allowed** (e.g. `Read`, `Glob`, `Grep`, `TodoWrite`) → runs; the plugin
    stays silent so Claude Code's own permission system still applies (it never
    auto-approves on your behalf).
  - **Denied** (e.g. `rm -rf`, reading `~/.ssh`, `curl|sh`, metadata endpoints) →
    blocked with an AGT reason.
  - **Reviewed** (e.g. `Bash`, `Edit`, `Write`, `WebFetch`, `WebSearch`, `Task`) →
    surfaced as Claude Code's **interactive approval prompt**; it runs if you
    approve.
- **Tool output (`PostToolUse`)** — scanned for prompt-injection / exfiltration
  cues. Claude Code can't un-send output, so flagged output is **downgraded to a
  strong "treat as untrusted" warning** rather than removed.
- **Prompts (`UserPromptSubmit`)** — scanned for injection/poisoning. A standing
  guardrail context is injected; a prompt that looks like an attack is **blocked
  by rewriting** it to a refusal (Claude Code can't hard-reject a prompt).
- **Session start (`SessionStart`)** — loads the policy and prints a status line.
- **A skill being invoked** is gated **before it runs** (`PreToolUse`): its
  manifests (including PEP 723 inline metadata) get metadata-hygiene + an
  attestation lookup, plus dangerous-pattern / secret / prompt-injection /
  capability-profile scans. In the default `enforce` posture a skill is allowed
  silently only if it carries a valid stamp (a CI signature or a fresh local
  scan); an unattested skill triggers a one-time approval prompt, and a
  vulnerable or dangerous skill is denied. See
  [Trusting skills — two tiers](#trusting-skills--two-tiers) below.

## Profiles at a glance

The bundled default is **`balanced`**. Four profiles ship in
`config/profiles/`; they carry the **same** threat rules + extensions and differ
only in the tool tiers / mode:

| Profile | Mode | Reviewed (interactive approval) | Persistence writes (shell profiles, git hooks, task configs) | Heuristic detections |
|---|---|---|---|---|
| **strict** | enforce | shell / edit / web / task | **denied** | enforced |
| **balanced** *(default)* | enforce | `Bash` `PowerShell` `Edit` `Write` `WebFetch` `WebSearch` `Task` `NotebookEdit` | **reviewed** (interactive approval) | enforced |
| **secure-low-friction** *(recommended)* | enforce | only `Task` (subagent spawning) | reviewed | enforced |
| **advisory** | advisory | (same split as balanced) | reviewed | **warn only** — hard rules (`rm -rf`, secret reads) still block |

`secure-low-friction` is the **recommended** profile when you want security
without the prompting: it allows the everyday tools (`Bash`/`Edit`/`Write`/
`WebFetch`/…) and reviews only `Task`, while the named threat rules + exfil/DLP/
content-safety still enforce — so dangerous calls are still blocked, you just
drop the blanket "approve everything" prompting.

Because Claude Code renders `review` as an interactive prompt, reviewed tools
still run once you approve them. To change profile, copy one over a policy path —
see [CONFIGURATION.md](CONFIGURATION.md).

## Trusting skills — two tiers

Skills are third-party code **plus third-party dependencies** running inside the
agent, so `skillPolicies` + `dependencyPolicies` gate a skill before it runs
(both `enforce` by default). A skill is trusted by a **stamp** (an attestation),
and there are two ways to get one — a strong durable tier and a weak time-boxed
tier:

**1. CI-signed (strong, durable) — recommended for shared / published skills.** A
signer *outside the agent box* (CI / HSM) resolves the skill's full transitive
dependency tree, CVE-scans it, and — only if it passes — signs the attestation
with an Ed25519 private key the agent machine never holds. The signed
`.agt-attestation.json` ships **alongside the skill**; the plugin **verifies** it
against the trusted **public key** you configure in
`skillPolicies.trustedSigners` (delivered out of band, never bundled). A local
attacker can't forge this — they lack the private key, and **CI never signs a
failing skill, so a valid signature *is* the pass.** Run the **separate** signer
in CI, never on an agent box — see
[`tools/skill-signer/README.md`](../tools/skill-signer/README.md):

```bash
# in CI, with the PRIVATE key that never touches an agent machine:
node tools/skill-signer/sign.mjs <skill-dir> --key <ci-private.pem> [--threshold high]
#   PASS → writes <skill-dir>/.agt-attestation.json (exit 0)
#   FAIL (finding ≥ threshold, or unscannable) → NOT signed (exit 1)
```

**2. Local first-use grace (weak, default) — for dev / unsigned skills.** A skill
with no valid CI signature is **scanned locally on first use**. Claude Code has
**no `skills audit` CLI verb** (unlike the OpenCode seat) — instead the proactive
audit is a script you run directly:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/skills-audit.mjs <skill-dir> [<skill-dir> …] [--scanner trivy|osv-scanner|pip-audit]
```

This resolves the **full transitive tree** (`uv` for Python incl. PEP 723 inline;
`npm` for Node) and runs an auto-detected scanner (`trivy` / `osv-scanner` /
`pip-audit`), then writes a local stamp so the first real use is a cheap cache
hit instead of an inline scan or an approval prompt. `${CLAUDE_PLUGIN_ROOT}` is
set by Claude Code; point the script at a single skill directory (contains
`SKILL.md`) or a parent that holds many (e.g. `~/.claude/skills`).

This local tier is **forgeable but time-boxed** — a local writer could plant a
stamp, so it is only a guardrail, not the durable boundary. Set
`skillPolicies.requireSignature: true` for **strict mode** (CI-signed skills
only, no local fallback).

### First-use approval and the `user-approved` cert

When `skillPolicies` is in `enforce` (the default) and you invoke an **unattested**
skill that hasn't been pre-audited, the plugin **stops and asks you to approve it
once** (an interactive prompt, the same `ask` channel as a reviewed tool). On
approval it writes a `user-approved` certificate bound to the skill's current
files; the **unchanged** skill then runs **silently** on subsequent uses. The
approval is invalidated as soon as the skill's files change — editing or
re-publishing the skill forces a fresh approval. Pre-scan with
`scripts/skills-audit.mjs` (above) to avoid that first prompt entirely.

> **How this relates to the "local 1-day grace" tier.** Both are the *weak,
> local, forgeable* tier (as opposed to the durable CI-signed tier) — but they
> are described two ways in the codebase and have not yet been reconciled:
> - The plugin README frames the local tier as a **scan-on-first-use stamp valid
>   for ~1 day**, after which the skill must be re-scanned or CI-signed.
> - The shipped policy `_note` (`skillPolicies` in `default-policy.json`) frames
>   it as a **one-time stop-and-approve that writes a `user-approved` cert**, so
>   the *unchanged* skill runs silently (re-prompting only when files change),
>   with no fixed expiry mentioned.
>
> In both framings the tier is local and forgeable and only the CI-signed tier
> resists a local attacker; treat the exact stamp lifetime (1-day expiry vs.
> file-change invalidation) as **subject to reconciliation** — see the
> contradiction note at the end of this section.

> **Fail-safe behavior (a guardrail, not a guarantee):** a skill is stamped
> clean-eligible only when its deps were actually resolved transitively **and**
> scanned clean (or carry a valid CI signature). If `uv`/`npm` or a scanner is
> missing, the resolver errors, or a bare-import JS skill has no manifest,
> coverage is `unavailable` → **unverified = unsafe** (review/deny), never a
> false-clean. The scan catches *known* CVEs / known patterns (the CVE step is
> delegated to trivy/osv) — **not** novel or zero-day code; only the CI-signed
> tier resists a local forger; and a true execution boundary needs OS-level
> isolation, which this is not.

See [CONFIGURATION.md](CONFIGURATION.md#skill--dependency-supply-chain-governance)
for the `skillPolicies` / `dependencyPolicies` key reference and the optional
[intent judge](CONFIGURATION.md#intent-judge-optional-llm-as-judge--off-by-default)
(documented in [LLM-JUDGE.md](LLM-JUDGE.md)).

## The audit log

Every decision is appended to `${CLAUDE_PLUGIN_DATA}/audit-log.json` (or
`~/.claude/agt/audit-log.json`) as a SHA-256 hash-chained record. The chain
**accumulates across hook invocations and persists across plugin updates** (it's
stored outside the plugin cache). `SessionStart` status reports whether it
verifies.

It is **tamper-evident, not tamper-proof** (keyless chain — see
[OVERVIEW.md](OVERVIEW.md#security-model--read-this)). For true non-repudiation,
forward entries to an append-only sink (SIEM / WORM).

## Tool-name notes

The shipped policy is retargeted to Claude Code tool names: `Bash`, `PowerShell`,
`Edit`, `Write`, `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `NotebookEdit`,
`Task`. Claude Code's shell tool is `Bash` on every platform; the `PowerShell`
tool only exists behind `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`. The shell command
rules are duplicated for both tools and each carries **both** Unix and PowerShell
patterns, so dangerous commands are caught regardless of which shell tool is
active. `mcp__*` tools need no policy entry — every MCP call is scanned
automatically.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Every tool call is denied | Fail-closed: the policy failed to load (a bad custom policy denies by design). Check `SessionStart` status; validate your override JSON. |
| The plugin doesn't seem active | Restart Claude Code or `/reload-plugins`; confirm Node ≥ 18 is on PATH. |
| A policy edit had no effect | Confirm the resolution order — a `<project>/.claude/agt-policy.json` shadows your per-user `policy.json`. Restart the session. |
| Reviewed tools never prompt | They should appear as Claude Code's normal approval prompt; if you've set them to `deny` in a custom policy, they'll be blocked instead. |
