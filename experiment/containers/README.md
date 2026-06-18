# Phase 1 — Containers & isolation (Claude Code host)

Sealed Docker environment for the settings-vs-plugin benchmark
(`../../../BENCHMARK-PLAN.md`). The isolation scaffolding (three networks, egress
gateway, mock-metadata, decoys, proof) is IDENTICAL to the agt-opencode side;
only the agent image and the allowlisted model domain differ.

## Host-specific differences from agt-opencode

| Aspect | Claude Code |
|---|---|
| Agent CLI | `@anthropic-ai/claude-code@2.1.160` (not opencode-ai). |
| Corporate CA | Installed into the **system** trust store (`update-ca-certificates`) because the plan specifies `NODE_OPTIONS=--use-system-ca`; `NODE_EXTRA_CA_CERTS` is also set. |
| Plugin | The `agt-governance` plugin tree (with its built `vendor/` SDK) is copied in as a local marketplace at `/opt/agt-claude-code` (the live harness enables it via settings.json). |
| `ALLOW_DOMAIN` | Defaults to `api.anthropic.com` (the model endpoint for CC). |
| Live credential | `CLAUDE_CODE_OAUTH_TOKEN` (minted via `claude setup-token`), runtime-only. |

Everything else — `none`/`ssrf`/`live` modes, the gateway allowlist + DNAT,
mock-metadata, decoys/canaries, and the hardening (non-root, cap-drop ALL,
read-only FS, limits) — mirrors agt-opencode. **No secret is baked into any
image.**

## Reproduce the isolation proof

```bash
node prepare-context.mjs                       # stage CA + the plugin tree (gitignored)
node gen-decoys.mjs >/dev/null                 # fresh decoys + canaries
export CANARY_METADATA=$(node -e "console.log(require('./decoys/canaries.json').metadataCanary)")
ALLOW_DOMAIN=api.anthropic.com node prove-isolation.mjs
```

Expected: `== 9/9 isolation assertions held ==` (real `200` to `api.anthropic.com`,
real `403` + `TCP_DENIED` for a per-run sentinel). The ALLOW assertion only opens
a CONNECT tunnel, so the proof needs no subscription token; the token is required
only for the Phase-5 live track.

`prepare-context.mjs` requires the plugin's `vendor/` SDK to exist — run
`node scripts/build-vendor.mjs` at the repo root first. If the repos are not
siblings, set `CORPORATE_CA=<path-to-corporate-ca.pem>`.

## Pins

- base: `node:22-bookworm-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732`
- `@anthropic-ai/claude-code@2.1.160`
- gateway base: `debian:bookworm-slim@sha256:40b107342c492725bc7aacbe93a49945445191ae364184a6d24fedb28172f6f7`
