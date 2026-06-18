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

All three share the same allowed/reviewed tool split (read-family allowed; shell,
edit, web, task reviewed). They differ only in:

- **strict** — persistence-oriented writes (`.bashrc`, git hooks, `tasks.json`,
  …) are **denied**; heuristics enforced.
- **balanced** *(default)* — same, but those persistence writes are **reviewed**
  (interactive approval) instead of denied.
- **advisory** — same rules as balanced but in advisory mode: explicit hard rules
  (`rm -rf`, secret reads) still block, while heuristic detections
  (prompt-injection, poisoning, MCP scan) only **warn**. Lowest friction — good
  for first rollout.

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
