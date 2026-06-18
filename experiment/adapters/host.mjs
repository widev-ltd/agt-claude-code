// Copyright (c) 2026 AGT Governance plugin contributors.
// Licensed under the MIT License.
//
// host.mjs — Claude Code host adapter for the adversarial benchmark.
//
// Renders a host-NEUTRAL corpus case (abstract_action: {kind, payload, target})
// into a Claude Code hook-event JSON object. The CC deterministic runner writes
// this object to the stdin of the REAL hook entry point
// plugins/agt-governance/scripts/agt-hook.mjs and reads the decision JSON from
// stdout. Hook event shape (per agt-hook.mjs handleEvent):
//   PreToolUse:      {hook_event_name, tool_name, tool_input, session_id, cwd}
//   PostToolUse:     {hook_event_name, tool_name, tool_response, session_id, cwd}
//   UserPromptSubmit:{hook_event_name, prompt, session_id, cwd}
//
// The corpus carries NO host tool names; this adapter owns the mapping from the
// abstract `kind` to Claude Code's PascalCase tool ids and tool_input keys (which
// the CC default policy is written against — Read/Bash/Edit/Write/WebFetch). The
// OC adapter maps the SAME corpus to OpenCode's function-call API. Corpus is
// byte-identical and hash-verified across both repos; only the adapters differ.

export const HOST = "cc";

const SESSION_ID = "bench-cc-session";
const CWD = "/work/project";

// Claude Code tool ids are PascalCase (see CC config/default-policy.json).
const KIND_TO_TOOL = {
  shell_command: "Bash",
  file_read: "Read",
  file_write: "Write",
  url_fetch: "WebFetch",
  mcp_tool_definition: "mcp__external__tool",
};

// Default tool_input key per kind. Overridable via render_hints.arg_key.
const KIND_TO_ARG_KEY = {
  shell_command: "command",
  file_read: "file_path",
  file_write: "file_path",
  url_fetch: "url",
};

// Map a host-NEUTRAL render_hints.source_tool (canonical lowercase: bash,
// webfetch, websearch, …) to Claude Code's PascalCase tool id. The engine
// classifies tool output by tool id (CC suppressTools=[WebFetch,WebSearch];
// advisoryTools=[Bash,PowerShell]), so the SOURCE name/casing is load-bearing
// for tool-output scoring — a host-neutral lowercase hint MUST be mapped to
// CC casing or the membership check silently misses. (On CC ALL post-tool
// output degrades to advisory anyway — hooks can't retract output that ran —
// but we still render the correct source so the engine sees the real tool.)
const SOURCE_TOOL_TO_TOOL = {
  bash: "Bash",
  shell: "Bash",
  powershell: "PowerShell",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  fetch: "WebFetch",
  read: "Read",
  write: "Write",
};
function resolveSourceTool(sourceTool) {
  if (!sourceTool) return "Bash"; // default: bash-sourced
  const key = String(sourceTool).toLowerCase();
  return SOURCE_TOOL_TO_TOOL[key] ?? String(sourceTool); // fall through to raw
}

/**
 * Render an abstract corpus action into a Claude Code hook-event JSON object.
 *
 * @param {{kind:string, payload:string, target?:string, render_hints?:object}} abstractAction
 * @param {{cwd?:string, sessionId?:string}} [opts]
 * @returns {object} a hook-event object suitable for JSON.stringify -> agt-hook.mjs stdin.
 *   `call` mirrors the OC adapter so the shared scorer can branch identically;
 *   the CC runner uses `hook_event_name` to know which stdin payload to send.
 */
export function renderCase(abstractAction, opts = {}) {
  const { kind, payload, target } = abstractAction;
  const hints = abstractAction.render_hints ?? {};
  const cwd = opts.cwd ?? CWD;
  const session_id = opts.sessionId ?? SESSION_ID;
  const base = { session_id, cwd };

  switch (kind) {
    case "prompt":
      return {
        call: "promptSubmit",
        hook_event_name: "UserPromptSubmit",
        prompt: String(payload ?? ""),
        ...base,
      };

    case "tool_output":
      // source_tool is host-neutral; resolveSourceTool maps it to CC's PascalCase
      // tool id so the engine's suppressTools/advisoryTools classification is
      // correct (the source tool that produced the output is what's scanned).
      return {
        call: "toolOutput",
        hook_event_name: "PostToolUse",
        tool_name: resolveSourceTool(hints.source_tool),
        tool_response: String(payload ?? ""),
        ...base,
      };

    case "mcp_tool_definition": {
      // MCP scan runs in PreToolUse: tool_name + serialized tool_input feed the
      // scanner. Poisoned description goes in a string tool_input field.
      const tool_name = String(hints.mcp_tool_name ?? KIND_TO_TOOL.mcp_tool_definition);
      return {
        call: "preToolUse",
        hook_event_name: "PreToolUse",
        tool_name,
        tool_input: { description: String(payload ?? ""), ...(target ? { target } : {}) },
        ...base,
      };
    }

    case "shell_command":
      return {
        call: "preToolUse",
        hook_event_name: "PreToolUse",
        tool_name: KIND_TO_TOOL.shell_command,
        tool_input: { [hints.arg_key ?? KIND_TO_ARG_KEY.shell_command]: String(payload ?? "") },
        ...base,
      };

    case "file_read":
    case "file_write":
    case "url_fetch": {
      const tool_name = KIND_TO_TOOL[kind];
      const argKey = hints.arg_key ?? KIND_TO_ARG_KEY[kind];
      const value = target ?? payload;
      const tool_input = { [argKey]: String(value ?? "") };
      if (kind === "file_write" && payload) {
        tool_input.content = String(payload);
      }
      return { call: "preToolUse", hook_event_name: "PreToolUse", tool_name, tool_input, ...base };
    }

    default:
      throw new Error(`CC adapter: unsupported abstract_action.kind '${kind}'`);
  }
}
