# Research Report: AI Coding CLI Tools with Per-Tool Interactive Approval

Generated: 2026-02-12

## Summary

Only **three tools** currently offer true per-tool interactive approval where an external system can programmatically intercept each tool call and allow/deny it in real-time: **Claude Code** (via `--sdk-url` WebSocket / Agent SDK stdin/stdout), **OpenCode** (via `opencode serve` with SSE events and SDK permission callbacks), and **Cline CLI** (via the Agent Client Protocol / ACP over JSON-RPC stdio). Most other tools only offer binary modes (fully autonomous vs. fully manual TUI approval) without an external programmatic approval hook.

---

## Questions Answered

### Q1: OpenCode — Headless/SDK mode with interactive tool approval?

**Answer:** YES — OpenCode has full support for this.

**Headless Mode:** `opencode serve` runs a headless HTTP server with OpenAPI 3.1 spec.

**Per-Tool Interactive Approval:** OpenCode has a sophisticated permission system. When a tool requires approval:
1. Tool invocation calls `ctx.ask()` with permission type, patterns, and metadata
2. System evaluates patterns against the ruleset
3. If approval is needed, a `permission.asked` event is published via `Bus.publish()`
4. Execution **blocks** until a `permission.replied` event resolves or rejects the promise
5. An external client can subscribe to these events via SSE (`/event`, `/global/event`) and respond programmatically

**Protocol:** REST API (Hono framework) + Server-Sent Events (SSE) for real-time event streaming. Also supports WebSocket connections. The `@opencode-ai/opencode` SDK provides type-safe TypeScript client for HTTP and WebSocket APIs.

**Permission Configuration:** Per-tool granularity — you can `allow`, `deny`, or require `approval` for each tool individually in `opencode.json`.

**Confidence:** High

**Sources:**
- https://opencode.ai/docs/server/
- https://opencode.ai/docs/permissions/
- https://opencode.ai/docs/sdk/
- https://deepwiki.com/sst/opencode/2.5-question-and-permission-requests
- https://deepwiki.com/anomalyco/opencode/6.2-permission-system

---

### Q2: Aider — Programmatic interface with tool-by-tool approval callbacks?

**Answer:** NO — Aider does not have per-tool interactive approval callbacks.

**Headless Mode:** Aider supports `--yes` / `--yes-always` flags for fully autonomous operation without any approval prompts. It can be scripted via CLI or an unofficial Python API.

**Per-Tool Interactive Approval:** Not available. Aider's model is binary:
- Interactive: human confirms each edit in the terminal (TUI-based, not programmatically interceptable)
- Autonomous: `--yes` auto-approves everything

There is no structured protocol for an external system to receive approval requests and respond. A GitHub issue (#1438) from September 2024 requested callback functionality for headless automation, but the architecture does not support per-tool approval hooks.

**Protocol:** Aider is a Python CLI. No WebSocket, no JSON-RPC, no structured event stream. Scripting is via command-line arguments or importing the (unsupported) Python API.

**Confidence:** High

**Sources:**
- https://aider.chat/docs/scripting.html
- https://aider.chat/docs/config/options.html
- https://github.com/Aider-AI/aider/issues/1438

---

### Q3: Cursor Agent / CLI — Headless mode with interactive approval?

**Answer:** PARTIAL — Cursor has a headless CLI and Background Agent API, but per-tool approval is limited.

**Headless Mode:** Cursor shipped a CLI in January 2026 with `-p`/`--print` flags for non-interactive mode. Authentication via `CURSOR_API_KEY` environment variable. The Background Agent API allows programmatic creation and management of background agents.

**Per-Tool Interactive Approval:** The headless CLI agent can read/write files, search codebases, and "with approval" run shell commands. However, the approval mechanism appears to be:
- MCP tool calls require an `mcp-approvals.json` file for allowlisting
- Background agents can notify when approvals are needed
- Teams can set per-action policies (allow, warn, require step-up approval, deny)

The protocol for external real-time per-tool approval in headless mode is **not well-documented**. It appears to be more of a policy-based system than an interactive callback system.

**Protocol:** Cursor User API Key + REST API. No documented WebSocket or stdio protocol for approval callbacks.

**Confidence:** Medium — Cursor's headless features are evolving rapidly but the approval flow for external integrators is not clearly documented.

**Sources:**
- https://docs.slicervm.com/examples/cursor-cli-agent/
- https://github.com/mjdierkes/cursor-background-agent-api
- https://www.theagencyjournal.com/cursors-cli-just-got-a-whole-lot-smarter-fresh-updates-from-last-week/

---

### Q4: Continue.dev — Headless/server mode?

**Answer:** YES for headless, NO for per-tool interactive approval.

**Headless Mode:** Continue CLI (`cn`) supports headless mode with `-p` flag. In headless mode, it runs agents without any UI, outputs only the final response. Designed for CI/CD and automation. Authentication via `CONTINUE_API_KEY`.

**Per-Tool Interactive Approval:** Not available in headless mode. Headless mode is designed for fully autonomous operation — the agent runs to completion without interactive prompts. There is no documented callback or event system for external tool approval.

**Protocol:** CLI with stdout for results. No documented WebSocket or JSON-RPC for interactive communication.

**Confidence:** High

**Sources:**
- https://docs.continue.dev/guides/cli
- https://github.com/continuedev/continue
- https://www.npmjs.com/package/@continuedev/cli

---

### Q5: Cline / Roo Code — Headless mode with approval?

**Answer:**

**Cline CLI:** YES — via ACP (Agent Client Protocol)

Cline CLI 2.0 supports two modes:
1. **Interactive TUI** — human approves each tool in terminal (default)
2. **Headless (`-y`/`--yolo`)** — fully autonomous, no approval
3. **ACP mode** — THIS IS THE KEY ONE

The **Agent Client Protocol (ACP)** is a JSON-RPC 2.0 protocol over stdio that Cline implements. In ACP mode:
- An editor/client spawns `cline` as a subprocess
- Communication happens over stdin/stdout using JSON-RPC 2.0
- The agent **streams progress notifications** and **requests approval when needed**
- The client can approve or deny each tool call
- This is exactly the per-tool interactive approval pattern

Additionally, `--json` flag produces machine-readable NDJSON output for each message.

**Protocol:** JSON-RPC 2.0 over stdio (ACP), or NDJSON output with `--json` flag.

**Roo Code:** IN DEVELOPMENT — CLI/headless support is actively being built (as of Jan 2026, types and core functionality are being extracted for CLI support). A GitHub issue (#3835) tracks headless execution support. Currently tightly bound to VS Code unless using Roo Code Cloud. No per-tool approval protocol documented yet.

**Confidence:** High for Cline, Medium for Roo Code

**Sources:**
- https://docs.cline.bot/cline-cli/overview
- https://deepwiki.com/cline/cline/12.5-agent-client-protocol-(acp)
- https://agentclientprotocol.com/overview/architecture
- https://github.com/RooCodeInc/Roo-Code/issues/3835
- https://cline.bot/blog/announcing-cline-cli-2-0

---

### Q6: Windsurf (Codeium) — CLI mode?

**Answer:** NO meaningful CLI/headless mode for agent usage.

**Headless Mode:** Windsurf is an IDE-first product (fork of VS Code). You can install `windsurf` in PATH to launch the editor from command line, but there is no headless agent mode, no subprocess API, and no documented protocol for programmatic control.

**Per-Tool Interactive Approval:** Only within the IDE UI (Cascade agent). No external/programmatic approval mechanism.

**Protocol:** None documented for external integration.

**Confidence:** High

**Sources:**
- https://windsurf.com/editor
- https://docs.windsurf.com/windsurf/getting-started

---

### Q7: Other coding agents with programmatic per-tool approval

#### Claude Code (reference — your existing implementation)
- **Headless:** `--sdk-url` WebSocket flag, or Agent SDK (Python/TypeScript) via subprocess stdin/stdout
- **Per-Tool Approval:** `control_request` with subtype `can_use_tool` — pauses execution, waits for `control_response` with allow/deny
- **Protocol:** NDJSON over WebSocket (`--sdk-url`) or JSON over stdin/stdout (Agent SDK)
- **Callback:** `can_use_tool` callback in SDK; permission processing order: PreToolUse Hook → Deny Rules → Allow Rules → Ask Rules → Permission Mode Check → canUseTool Callback → PostToolUse Hook
- **Sources:** https://code.claude.com/docs/en/headless, https://code.claude.com/docs/en/sdk/sdk-permissions

#### OpenAI Codex CLI
- **Headless:** Supports `--full-auto` mode and device-code auth for headless environments
- **Per-Tool Approval:** Has three approval modes (Suggest/Auto-Edit/Full Auto), but these are **upfront policy modes**, not per-tool interactive callbacks. The `notify` config can run an external program on events, but this is notification-only, not approval. Can be run as an MCP server (`codex mcp-server`) via Agents SDK for subprocess orchestration.
- **Protocol:** Can be wrapped as MCP server via stdio. No native per-tool approval callback protocol.
- **Confidence:** High
- **Sources:** https://developers.openai.com/codex/cli, https://developers.openai.com/codex/cli/features/, https://developers.openai.com/codex/guides/agents-sdk/

#### Gemini CLI (Google)
- **Headless:** Full headless mode with `--output-format json` producing NDJSON events
- **Per-Tool Approval:** Binary: `--yolo` auto-approves everything, otherwise interactive TUI. No external approval callback. Events stream as NDJSON but are read-only (no way to send approval back).
- **Protocol:** NDJSON output stream (read-only), no bidirectional protocol
- **Confidence:** High
- **Sources:** https://google-gemini.github.io/gemini-cli/docs/cli/headless.html, https://geminicli.com/docs/cli/headless/

#### Goose (Block/Linux Foundation)
- **Headless:** Full headless mode for CI/CD and automation
- **Per-Tool Approval:** No interactive approval in headless mode. Operations either use default permissions or fail. `GOOSE_MODE=auto` auto-approves safe operations. No external callback mechanism.
- **Protocol:** CLI-based, no documented subprocess protocol for approval
- **Confidence:** High
- **Sources:** https://block.github.io/goose/docs/tutorials/headless-goose/, https://github.com/block/goose

#### Kiro CLI (AWS)
- **Headless:** Full ACP support via `kiro-cli acp`
- **Per-Tool Approval:** YES — implements ACP (JSON-RPC 2.0 over stdio). Same protocol as Cline. Agent requests approval, client responds. URLs not matching trusted patterns prompt for approval.
- **Protocol:** JSON-RPC 2.0 over stdin/stdout (ACP)
- **Confidence:** High
- **Sources:** https://kiro.dev/docs/cli/acp/, https://kiro.dev/blog/kiro-adopts-acp/

#### Amazon Q Developer CLI
- **Headless:** CLI agent available, but no documented headless mode with external approval
- **Per-Tool Approval:** Interactive approval in TUI only. No external callback mechanism documented.
- **Protocol:** CLI-based
- **Confidence:** Medium
- **Sources:** https://aws.amazon.com/about-aws/whats-new/2025/03/amazon-q-developer-cli-agent-command-line/

---

## Comparison Matrix

| Tool | Headless Mode | Subprocess | Per-Tool Interactive Approval | Protocol | Maturity |
|------|:---:|:---:|:---:|:---:|:---:|
| **Claude Code** | Yes | Yes | **YES** — `control_request`/`control_response` | NDJSON/WebSocket or JSON/stdio | Production |
| **OpenCode** | Yes (`serve`) | Yes | **YES** — `permission.asked`/`permission.replied` events | REST + SSE (+ WebSocket) | Production |
| **Cline CLI** | Yes (`-y`) | Yes | **YES** — via ACP | JSON-RPC 2.0 / stdio (ACP) | Production |
| **Kiro CLI** | Yes (ACP) | Yes | **YES** — via ACP | JSON-RPC 2.0 / stdio (ACP) | New (Feb 2026) |
| **Cursor CLI** | Yes (`-p`) | Partial | **Partial** — policy-based, not real-time callback | REST API | Beta |
| **Codex CLI** | Yes (`--full-auto`) | Yes (MCP) | **No** — upfront mode selection only | MCP/stdio (as server) | Production |
| **Gemini CLI** | Yes (`--yolo`) | Yes | **No** — binary auto/manual | NDJSON output (read-only) | Production |
| **Continue CLI** | Yes (`-p`) | Yes | **No** — headless = fully autonomous | stdout | Production |
| **Goose** | Yes | Yes | **No** — auto or fail in headless | CLI | Production |
| **Aider** | Yes (`--yes`) | Yes | **No** — binary auto/manual | CLI / Python API | Production |
| **Roo Code** | In development | No | **No** — VS Code only for now | N/A | Alpha |
| **Windsurf** | No | No | **No** — IDE only | N/A | N/A |
| **Amazon Q CLI** | Partial | Yes | **No** — TUI approval only | CLI | Production |

---

## Recommendations

### For The Companion (this codebase)

The Companion currently reverse-engineers Claude Code's `--sdk-url` WebSocket protocol for per-tool approval. If you want to support additional agents:

1. **OpenCode** is the strongest candidate — it has a well-documented REST+SSE server with per-tool `permission.asked`/`permission.replied` events and a TypeScript SDK. The architecture (HTTP server with SSE event stream) is similar enough to bridge into the Companion's WebSocket-to-browser architecture.

2. **Cline CLI via ACP** is the second candidate — spawn as subprocess, communicate via JSON-RPC 2.0 over stdio. Would need a bridge from stdio JSON-RPC to the Companion's WebSocket protocol.

3. **Kiro CLI via ACP** uses the same protocol as Cline (ACP), so supporting one means supporting the other.

4. **Codex CLI** can be run as an MCP server but lacks per-tool approval — it would only work in "full auto" mode unless you wrap it with custom approval logic.

### Implementation Notes

- **ACP (Agent Client Protocol)** is emerging as a standard. If you implement ACP client support, you get Cline, Kiro, and any future ACP-compatible agents for free. The spec is at https://agentclientprotocol.com/
- **OpenCode's REST+SSE** approach is architecturally closest to the Companion's existing HTTP+WebSocket design. No subprocess management needed — just HTTP calls and SSE subscription.
- **Claude Code's protocol** remains the most mature and best-documented for this exact use case (it was designed for exactly this pattern).

---

## Sources

1. [OpenCode Server Docs](https://opencode.ai/docs/server/) — Server mode and API documentation
2. [OpenCode Permissions](https://opencode.ai/docs/permissions/) — Per-tool permission configuration
3. [OpenCode SDK](https://opencode.ai/docs/sdk/) — TypeScript SDK for programmatic control
4. [OpenCode Permission System (DeepWiki)](https://deepwiki.com/sst/opencode/2.5-question-and-permission-requests) — Detailed permission.asked/replied flow
5. [Aider Scripting Docs](https://aider.chat/docs/scripting.html) — Scripting and automation
6. [Aider Callback Feature Request](https://github.com/Aider-AI/aider/issues/1438) — Requested but not implemented
7. [Cline CLI Overview](https://docs.cline.bot/cline-cli/overview) — CLI modes and features
8. [Cline ACP (DeepWiki)](https://deepwiki.com/cline/cline/12.5-agent-client-protocol-(acp)) — ACP implementation details
9. [Agent Client Protocol Spec](https://agentclientprotocol.com/overview/architecture) — ACP architecture and protocol
10. [Cline CLI 2.0 Announcement](https://cline.bot/blog/announcing-cline-cli-2-0) — Latest CLI features
11. [Roo Code Headless Issue](https://github.com/RooCodeInc/Roo-Code/issues/3835) — CLI/headless support tracking
12. [Windsurf Editor](https://windsurf.com/editor) — IDE-only, no CLI agent mode
13. [Continue CLI Guide](https://docs.continue.dev/guides/cli) — Headless mode documentation
14. [Claude Code Headless Docs](https://code.claude.com/docs/en/headless) — SDK and subprocess protocol
15. [Claude Code SDK Permissions](https://code.claude.com/docs/en/sdk/sdk-permissions) — can_use_tool callback
16. [Codex CLI Docs](https://developers.openai.com/codex/cli) — Approval modes and features
17. [Codex Agents SDK Guide](https://developers.openai.com/codex/guides/agents-sdk/) — MCP server mode
18. [Gemini CLI Headless](https://google-gemini.github.io/gemini-cli/docs/cli/headless.html) — NDJSON event output
19. [Goose Headless Tutorial](https://block.github.io/goose/docs/tutorials/headless-goose/) — Headless mode limitations
20. [Kiro CLI ACP Docs](https://kiro.dev/docs/cli/acp/) — ACP implementation
21. [Kiro Adopts ACP Blog](https://kiro.dev/blog/kiro-adopts-acp/) — ACP announcement
22. [Headless Cursor Agent (Slicer)](https://docs.slicervm.com/examples/cursor-cli-agent/) — Cursor CLI headless usage
23. [Cursor Background Agent API](https://github.com/mjdierkes/cursor-background-agent-api) — Community API wrapper
24. [ACP GitHub Repository](https://github.com/agentclientprotocol/agent-client-protocol) — Protocol specification
25. [Tembo 2026 CLI Tools Comparison](https://www.tembo.io/blog/coding-cli-tools-comparison) — Overview of 15 agents

## Open Questions

- Does Cursor's Background Agent API support real-time per-tool approval via webhook or callback? Documentation is sparse.
- Will Roo Code's CLI support ACP when it ships? The codebase extraction work suggests it's heading that direction.
- Does Amazon Q Developer CLI have an undocumented subprocess protocol similar to Claude Code's?
- How stable is the ACP specification? It is relatively new and may change.
