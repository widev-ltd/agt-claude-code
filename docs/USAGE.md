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

## Profiles at a glance

The bundled default is **`balanced`**. Three profiles ship in
`config/profiles/`; they share the same allowed/reviewed tool split and differ
only in two dimensions:

| Profile | Mode | Persistence writes (shell profiles, git hooks, task configs) | Heuristic detections |
|---|---|---|---|
| **strict** | enforce | **denied** | enforced |
| **balanced** *(default)* | enforce | **reviewed** (interactive approval) | enforced |
| **advisory** | advisory | reviewed | **warn only** — hard rules (`rm -rf`, secret reads) still block |

Because Claude Code renders `review` as an interactive prompt, reviewed tools
still run once you approve them. To change profile, copy one over a policy path —
see [CONFIGURATION.md](CONFIGURATION.md).

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
