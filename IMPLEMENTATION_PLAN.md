# Implementation plan

## Goals

1. Run every agent conversation on Pi Durable, with dependencies pinned to current releases.
2. Give each agent its own Durable Object, so its conversation, status, workspace files, and container snapshot outlive any one request.
3. Give agents a workspace and shell (Computer), Code Mode, a browser, web search and fetch, MCP servers, Artifacts repositories, image generation, and a Linux container.
4. Log run status, tool results, durations, and errors, with Effect spans and Cloudflare traces.
5. Check a clean install, the types, and Wrangler's build; document the bindings and known limits.

## Done

- Pinned the releases current on 2026-11-06: Pi Durable 1.5, Agents 0.33, Computer 0.10, Code Mode 0.5.6, Effect 4.1, AI SDK 7.0.163, Wrangler 4.158.
- Each agent is a named `PiAgent` Durable Object. `PiHarness` from Agents stores Pi's data and resumes Pi after a restart.
- `delegate` starts a subagent as a child conversation owned by the calling tool, and finds the same child if it runs again after a restart.
- Computer's workspace tools go straight to Pi, each with its own rule for running again after a restart. The worker shell works: the Worker exports `WorkspaceServiceProxy` and the agent exposes `__getWorkspaceStub()`.
- `code_mode` uses Code Mode's runtime (`createCodemodeRuntime`, `runtime.execute()`), with connectors for the workspace, the web, and each MCP server.
- `browser`, `web_search`, and `web_fetch` are Agents' tools for Pi.
- The container restores its last snapshot when it starts and saves a new one after each command.
- The Event Lab's WebSocket gets Pi's conversation state on every change. Watches are restarted after hibernation and after Pi reopens.
- Launched runs record their result when Pi finishes them, without waiting for a status request.
- Events are stored in a SQL table. Request bodies and `MCP_SERVERS_JSON` are checked with Effect Schema.
- Checked: `npm ci`, a strict typecheck, and `wrangler deploy --dry-run`.
- Local test with Workers AI and Artifacts faked: start, status, inspect, WebSocket, run, and resume; workspace tools and shell `exec`; `code_mode` scripts using the workspace, web, and `codemode.search()`. The run ends with `model_error`, as expected without a model.

## Not yet checked

- A full run, restart, and recovery against real Workers AI. This container has no Cloudflare credentials.
- `delegate`, which needs a model.
- `container_exec`, which needs Docker locally.
- `browser`: the call reaches Wrangler's local browser, but Chromium refuses to start as root in this container.
