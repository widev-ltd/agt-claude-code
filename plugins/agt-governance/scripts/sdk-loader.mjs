// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SDK_ENTRY_ENV = "AGT_COPILOT_SDK_ENTRY";
export const UNSAFE_SDK_OVERRIDE_ENV = "AGT_COPILOT_ALLOW_UNSAFE_SDK_OVERRIDE";

const VENDORED_SDK_RELATIVE_PATH =
  "./vendor/agent-governance-sdk/node_modules/@microsoft/agent-governance-sdk/dist/index.js";

// PERF: the SDK barrel (index.js) re-exports ./encryption, which eagerly pulls
// in @noble (~4.1 MB of crypto) plus js-yaml/argparse — none of which this
// plugin uses. Since Claude Code spawns a FRESH PROCESS per hook event, that
// import is paid on every tool call (~180 ms measured). policy.mjs only ever
// touches four SDK classes, and each lives in a submodule that requires nothing
// heavier than node's `crypto` (js-yaml is required lazily, inside functions we
// never hit). So for the VENDORED SDK we import those submodules directly and
// assemble an object with the same shape policy.mjs consumes — dodging the
// crypto tree entirely with zero behaviour change. An explicit operator SDK
// override (AGT_COPILOT_SDK_ENTRY) is still loaded as a full barrel (correctness
// over speed for the escape hatch).
const VENDORED_SDK_SUBMODULES = [
  "policy.js", // PolicyEngine, PolicyConflictResolver
  "mcp.js", // McpSecurityScanner, McpThreatType
  "prompt-defense.js", // PromptDefenseEvaluator
  "context-poisoning.js", // ContextPoisoningDetector
];

// Merge a CJS-or-ESM module namespace into `target`. A vendored submodule is
// TypeScript-compiled CommonJS: `await import()` exposes the classes both as
// synthesized named exports AND on `.default` (= module.exports). We merge both
// so the assembled object has every class regardless of interop nuance.
function mergeSdkModule(target, mod) {
  const ns = mod?.default;
  if (ns && typeof ns === "object") {
    Object.assign(target, ns);
  }
  for (const [key, value] of Object.entries(mod)) {
    if (key !== "default") {
      target[key] = value;
    }
  }
  return target;
}

async function assembleVendoredSdk(distDir) {
  const sdk = {};
  for (const file of VENDORED_SDK_SUBMODULES) {
    const mod = await import(pathToFileURL(join(distDir, file)).href);
    mergeSdkModule(sdk, mod);
  }
  return sdk;
}

export async function loadAgentGovernanceSdk({
  env = process.env,
  extensionRoot = dirname(fileURLToPath(import.meta.url)),
} = {}) {
  const extensionRootPath = realpathSync(resolve(extensionRoot));
  const vendoredSdkPath = resolve(extensionRootPath, VENDORED_SDK_RELATIVE_PATH);
  const candidates = [
    {
      path: vendoredSdkPath,
      source: "vendored",
    },
  ];

  if (env[SDK_ENTRY_ENV]) {
    const overridePath = resolve(String(env[SDK_ENTRY_ENV]));
    if (env[UNSAFE_SDK_OVERRIDE_ENV] === "true") {
      candidates.unshift({
        path: overridePath,
        source: "env-unsafe",
      });
    } else if (existsSync(overridePath)) {
      const canonicalOverridePath = realpathSync(overridePath);
      if (isPathContained(canonicalOverridePath, join(extensionRootPath, "vendor"))) {
        candidates.unshift({
          path: canonicalOverridePath,
          source: "env",
        });
      }
    }
  }

  const attempted = [];
  for (const candidate of candidates) {
    attempted.push(candidate.path);
    if (!existsSync(candidate.path)) {
      continue;
    }

    const canonicalCandidatePath = realpathSync(candidate.path);
    // Vendored SDK → narrow submodule import (dodges the @noble crypto tree).
    // Operator override → full barrel import (the documented escape hatch).
    if (candidate.source === "vendored") {
      const sdk = await assembleVendoredSdk(dirname(canonicalCandidatePath));
      return { path: canonicalCandidatePath, sdk, source: candidate.source };
    }
    const loaded = await import(pathToFileURL(canonicalCandidatePath).href);
    return {
      path: canonicalCandidatePath,
      sdk: loaded.default ?? loaded,
      source: candidate.source,
    };
  }

  throw new Error(
    [
       "Unable to locate the Agent Governance TypeScript SDK.",
        `Checked the vendored npm package and ${SDK_ENTRY_ENV}${env[UNSAFE_SDK_OVERRIDE_ENV] === "true" ? " (unsafe override enabled)" : ""}.`,
        `Paths: ${attempted.join("; ")}`,
      ].join(" "),
    );
}

function isPathContained(candidatePath, expectedRoot) {
  const normalizedCandidate = `${candidatePath.replace(/\\/g, "/").toLowerCase()}/`;
  const normalizedRoot = `${realpathSync(resolve(expectedRoot)).replace(/\\/g, "/").toLowerCase()}/`;
  return normalizedCandidate.startsWith(normalizedRoot);
}
