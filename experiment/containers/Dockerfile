# syntax=docker/dockerfile:1
#
# Benchmark agent image — Claude Code host (real `claude` CLI + the agt-governance
# plugin). In-container subject of the settings-vs-plugin benchmark
# (BENCHMARK-PLAN.md §Security/isolation, Phase 1).
#
# Hardening / fidelity goals mirror the OpenCode image; the differences are
# host-specific:
#   - Installs the pinned @anthropic-ai/claude-code CLI (NOT opencode-ai).
#   - Uses NODE_OPTIONS=--use-system-ca (per the plan): the corporate root CA must
#     live in the SYSTEM trust store, so we drop it into /usr/local/share/
#     ca-certificates and run update-ca-certificates — NODE_EXTRA_CA_CERTS alone is
#     not what the plan specifies for CC. We set both for belt-and-suspenders.
#   - The agt-governance plugin is copied in as a local marketplace (its built
#     vendor/ SDK included) so the live harness can enable it via settings.json
#     without network access.
#
# Credentials (CLAUDE_CODE_OAUTH_TOKEN) are NEVER baked in — injected at runtime
# via -e only (see docker-compose.yml). Runs NON-ROOT.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732
FROM ${NODE_IMAGE}

# Pinned host version (Phase-0 pin).
ARG CLAUDE_CODE_VERSION=2.1.160

# --- Corporate CA into the SYSTEM trust store (for --use-system-ca) ----------
# ca-certificates provides update-ca-certificates. The cert must have a .crt
# extension under /usr/local/share/ca-certificates for the updater to pick it up.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Build context is experiment/ (see docker-compose.yml); prepare-context.mjs
# stages the CA at containers/corporate-ca.pem.
COPY containers/corporate-ca.pem /usr/local/share/ca-certificates/corporate-ca.crt
RUN update-ca-certificates
# Belt-and-suspenders: also expose it to Node directly.
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/corporate-ca.crt
ENV NODE_OPTIONS=--use-system-ca
ENV npm_config_fund=false \
    npm_config_audit=false

# --- Real Claude Code CLI (pinned) -------------------------------------------
RUN npm i -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && claude --version

# --- The agt-governance plugin (local marketplace, vendored SDK included) -----
# The whole plugin repo is copied so the local-marketplace install path works
# offline. The live harness registers it via a settings.json that points
# `enabledPlugins` at this marketplace (configs/, Phase 3/5). build-vendor.mjs
# must have produced plugins/agt-governance/vendor/ before this build.
COPY plugin-src/ /opt/agt-claude-code/
RUN test -d /opt/agt-claude-code/plugins/agt-governance/vendor/agent-governance-sdk \
    || (echo "ERROR: plugin vendor/ missing — run scripts/build-vendor.mjs before docker build" && exit 1)

# --- Non-root runtime --------------------------------------------------------
USER node
WORKDIR /home/node/project

# Default idle shell; the harness overrides CMD per scenario (so a --network none
# run uses the same image). No agent ENTRYPOINT for the same reason.
CMD ["bash"]
