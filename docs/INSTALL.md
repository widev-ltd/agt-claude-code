# Install — agt-governance for Claude Code

## Prerequisites

- **Claude Code** (the CLI).
- **Node.js ≥ 18** on your `PATH` (`node --version`). Claude Code already ships
  with Node; the plugin uses only Node 18+ APIs.
- **No `npm` step** for end users — the AGT SDK is vendored inside the plugin.

---

## Install via the marketplace (recommended, end users)

```text
/plugin marketplace add widev-ltd/agt-claude-code
/plugin install agt-governance@agt-governance-marketplace
```

Then **restart Claude Code** (or run `/reload-plugins`).

That's it — the plugin's four hooks (PreToolUse, PostToolUse, UserPromptSubmit,
SessionStart) are now active and governing the session. On `SessionStart` it
prints a short governance status line so you can confirm it loaded.

---

## Install locally (development / trying it out)

Test just the plugin directory:

```text
claude --plugin-dir ./plugins/agt-governance
```

Or exercise the full marketplace flow from a local checkout:

```text
/plugin marketplace add ./agt-claude-code
/plugin install agt-governance@agt-governance-marketplace
claude plugin validate ./plugins/agt-governance
```

---

## Verifying it's active

- On a new session you should see the AGT `SessionStart` status line.
- Try a tool call the policy denies (e.g. ask the agent to read `~/.ssh/id_rsa`
  or run `rm -rf` on a real path) — it should be blocked with an AGT reason.
- Check the audit log is growing (see paths below).

---

## What gets written where

The plugin keeps state **outside** the plugin directory so it survives plugin
updates (Claude Code replaces the plugin cache on update):

| Path | What |
|---|---|
| `${CLAUDE_PLUGIN_DATA}/audit-log.json` (else `~/.claude/agt/audit-log.json`) | the hash-chained audit log |
| `${CLAUDE_PLUGIN_DATA}/policy.json` | an optional per-user policy override |
| `<project>/.claude/agt-policy.json` | an optional per-project policy override |
| bundled `config/default-policy.json` | the default (`balanced`) policy used when no override exists |

Policy resolution order (first match wins): per-project file → per-user file →
bundled default. See [CONFIGURATION.md](CONFIGURATION.md).

---

## Updating

Re-run the marketplace install to pull a newer plugin version:

```text
/plugin install agt-governance@agt-governance-marketplace
```

Your audit log and any policy override live outside the plugin cache, so they
are preserved across updates.

## Uninstalling

Remove the plugin through Claude Code's plugin management (`/plugin`). Your
`policy.json` override and `audit-log.json` are not deleted automatically — remove
them by hand if you want a clean slate.

---

## For maintainers — refreshing the vendored SDK

The self-contained SDK under `plugins/agt-governance/vendor/` is produced by
[`scripts/build-vendor.mjs`](../scripts/build-vendor.mjs):

```text
git clone https://github.com/microsoft/agent-governance-toolkit   # next to this repo
node scripts/build-vendor.mjs                                      # builds + vendors the TS SDK
# commit plugins/agt-governance/vendor/  → that is what makes install npm-free
```

Behind a corporate proxy, `npm install` inside the build may fail on TLS. Install
your corporate CA in the OS trust store (and on Node 22+ run with
`NODE_OPTIONS=--use-system-ca`) rather than disabling `strict-ssl`.

See [USAGE.md](USAGE.md) for what to do once it's installed.
