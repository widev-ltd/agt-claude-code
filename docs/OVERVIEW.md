# Overview — what agt-governance (for Claude Code) is and why it exists

## Purpose

`agt-governance` is a **runtime governance plugin for Claude Code**, distributed
through a small plugin marketplace in this repo. Its job is to make Claude Code
**enforce** safety rules instead of relying on the model to follow instructions.

Every tool call, user prompt, and tool result is evaluated against an explicit
policy *before/after* it is used. Dangerous operations are denied, risky ones are
sent to Claude Code's interactive approval prompt, prompts and tool output are
scanned for injection/poisoning, and every decision is appended to a
tamper-evident audit log.

It packages and adapts Microsoft's
[Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit)
(AGT). **It is an independent project — not affiliated with or endorsed by
Microsoft.** The AGT SDK is *vendored* inside the plugin, so end users install
with **no `npm` step**.

## What it actually does

| Concern | What the plugin does |
|---|---|
| **Dangerous commands** | Denies `rm -rf` (and PowerShell `Remove-Item -Recurse`, `find -delete`, `xargs rm`), `curl\|sh` bootstraps, cloud-metadata access, `iex` / `-EncodedCommand` / `certutil`. Rules cover both `Bash` and the opt-in `PowerShell` tool. |
| **Credential theft** | Denies reads of `.env`, `~/.ssh`, `~/.aws`, `~/.kube`, `.npmrc`, `id_rsa`, `$env:*TOKEN`, etc. |
| **Risky tools** | Sends `Bash`, `PowerShell`, `Edit`, `Write`, `WebFetch`, `WebSearch`, `Task`, `NotebookEdit` to **review** — which Claude Code renders as an interactive approval prompt. |
| **Prompt injection** | Scans each prompt for injection / context-poisoning; injects a standing guardrail context; blocks (rewrites) prompts that look like attacks. |
| **Tool-output poisoning** | Scans tool output for injected instructions and warns the model that flagged output is untrusted. |
| **MCP tool poisoning** | Every `mcp__*` tool call is scanned for poisoning/typosquatting automatically — no policy entry needed. |
| **Auditability** | Appends every decision to a persistent, SHA-256 hash-chained audit log that survives plugin updates. |

## How it works (architecture)

The plugin wires into **four Claude Code hooks** via
[`hooks/hooks.json`](../plugins/agt-governance/hooks/hooks.json), each invoking
`scripts/agt-hook.mjs`:

| Hook | Governance behaviour |
|---|---|
| `PreToolUse` | Allow / `ask` (interactive approval) / **deny** each tool call. |
| `PostToolUse` | Scan tool output for injection/exfiltration; warn that flagged output is untrusted (cannot be retracted). |
| `UserPromptSubmit` | Scan the prompt; inject the guardrail context; block (rewrite) injection-looking prompts. |
| `SessionStart` | Load the policy and report governance status. |

`agt-hook.mjs` reads the hook event JSON on stdin, hands it to the AGT engine
(`scripts/policy.mjs`, adapted from AGT; `poisoning.mjs` / `sdk-loader.mjs`
verbatim), and translates the decision back into Claude Code hook output. The
AGT SDK is vendored under `plugins/agt-governance/vendor/`.

```
tool call / prompt ──► AGT policy engine ──► allow / ask / deny ──► audit log
                       (deterministic, fail-closed)
```

## Security model — read this

- **In-process guardrail, not a sandbox.** Enforcement runs in the same
  trust/process boundary as the agent (a Claude Code hook process). It reliably
  gates well-behaved tool calls, but code that escapes the agent or the hook can
  bypass it. For hard isolation, run Claude Code inside a container or VM.
- **`ask` is a real interactive prompt.** Unlike the OpenCode port, Claude Code's
  `PreToolUse` `deny` genuinely blocks and `ask` genuinely prompts you — so
  "reviewed" tools run once you approve them.
- **The audit log is tamper-evident, not tamper-proof.** The hash chain detects
  edits/insertions/reordering and tail-truncation, but it is keyless: anyone who
  can write the log file can recompute a valid chain. Treat it as an integrity
  tripwire; forward to a SIEM/WORM sink for true non-repudiation.

## Where to go next

- [INSTALL.md](INSTALL.md) — install via the marketplace (or locally).
- [USAGE.md](USAGE.md) — what decisions look like, the audit log, day-to-day use.
- [CONFIGURATION.md](CONFIGURATION.md) — profiles, custom/per-project policy, tuning.
