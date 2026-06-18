# agt-claude-code

A Claude Code **plugin marketplace** that distributes **`agt-governance`** — a
runtime governance plugin powered by Microsoft's
[Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit).

This repository is both the marketplace and the plugin source. The AGT SDK is
**vendored** inside the plugin, so end users install with no `npm` step.

## Install (end users)

```text
/plugin marketplace add widev-ltd/agt-claude-code
/plugin install agt-governance@agt-governance-marketplace
```

See [plugins/agt-governance/README.md](plugins/agt-governance/README.md) for
what the plugin does, configuration, profiles, and limitations.

## Documentation

Detailed guides live in [`docs/`](docs/):

- [Overview](docs/OVERVIEW.md) — purpose, what it does, how it works, security model.
- [Install](docs/INSTALL.md) — marketplace install, local dev, verify, maintainer SDK build.
- [Usage](docs/USAGE.md) — what decisions look like, the audit log, troubleshooting.
- [Configuration](docs/CONFIGURATION.md) — policy resolution, profiles, policy schema, env vars.
- [LLM-as-judge](docs/LLM-JUDGE.md) — whether users can add an LLM judge, its advantages vs the deterministic rules, tradeoffs, and how to wire one up.
- [Benchmark](docs/BENCHMARK.md) — adversarial settings-vs-plugin benchmark: what `settings.json` already prevents and what the plugin adds, with reproducible per-category numbers.

## Repository layout

```
agt-claude-code/
├── .claude-plugin/marketplace.json     marketplace catalog
├── plugins/agt-governance/             the plugin (vendor/ is committed)
└── scripts/build-vendor.mjs            author-side SDK build + vendor step
```

## Building / refreshing the vendored SDK (maintainers)

The plugin ships a self-contained build of `@microsoft/agent-governance-sdk`
under `plugins/agt-governance/vendor/`. To produce or refresh it:

1. Clone the AGT source next to this repo:

   ```text
   git clone https://github.com/microsoft/agent-governance-toolkit
   ```

2. Run the vendor build:

   ```text
   node scripts/build-vendor.mjs
   ```

   It runs `npm install` + `npm run build` in the AGT TypeScript SDK source,
   then copies the compiled SDK and its runtime dependency tree into
   `plugins/agt-governance/vendor/`. Use `--sdk-src <path>` if the AGT clone is
   elsewhere; `--skip-install` / `--skip-build` to reuse a prior build.

3. Commit `plugins/agt-governance/vendor/` — that is what makes installation
   `npm`-free.

> Behind a corporate proxy, `npm install` may fail on TLS. Preferred fix:
> install the corporate CA in your OS trust store (and on Node 22+ run with
> `NODE_OPTIONS=--use-system-ca`), then retry. Disabling `strict-ssl` works but
> turns off certificate verification, so avoid it if you can.

## Testing locally

```text
claude --plugin-dir ./plugins/agt-governance
```

Or test the full marketplace flow:

```text
/plugin marketplace add ./agt-claude-code
/plugin install agt-governance@agt-governance-marketplace
claude plugin validate ./plugins/agt-governance
```

## Licensing

MIT. Vendors and adapts MIT-licensed components of Microsoft's Agent Governance
Toolkit — see [plugins/agt-governance/NOTICE](plugins/agt-governance/NOTICE).
