# Implementation plan

## Plan

1. Use Pi Durable as the only agent conversation/task runtime and pin current releases in this repository.
2. Host each agent in a named Durable Object so conversations, submissions, status, workspace files, and sandbox checkpoints survive request completion.
3. Give agents Code Mode, Computer, browser, Web Search, MCP, Artifacts Git, image generation, and a Linux Container.
4. Record operation status, tool outcomes, durations, errors, Effect spans, and Cloudflare platform traces.
5. Verify a clean install, types, and Wrangler's local build; document bindings and known release limits.
6. Create and push the requested GitHub repository once GitHub authentication is available.

## TODO

- [x] Inspect the repository and read the installed library APIs.
- [x] Check official release notes and announcements published from 2026-09-25 through 2026-10-02.
- [x] Pin Pi Durable 1.0, Effect 4, Cloudflare Agents, Computer, Code Mode, and supporting libraries.
- [x] Migrate Pi Durable registration to its 1.0 extension and registry APIs.
- [x] Launch each agent as an independent named `PiAgent` Durable Object, and keep its Pi Durable work on the Agent's installed lifecycle queue.
- [x] Add replay-safe task-owned Pi Durable child conversations for agent delegation.
- [x] Expose Computer, Browser, Web Search, MCP, and Artifacts through Cloudflare Code Mode.
- [x] Add durable workspace memory guidance and Workers AI image generation.
- [x] Restore Container snapshots on demand and save a new snapshot after each shell command.
- [x] Enable Cloudflare invocation logs and native custom spans; keep structured Effect span, status, and tool outcome logs.
- [x] Document current setup, local dependency age override, optional MCP service suggestions, and platform limits.
- [x] Verify `npm ci` and TypeScript using Node.js 24.19.
- [x] Run Wrangler dry-run using Node.js 24.19 after resolving the missing MCP SDK peer and incompatible PiHarness bridge.
- [x] Smoke-check local agent listing, input validation, named Durable Object launch, status polling, native Cloudflare launch/list spans, Effect span logs, and registry/status persistence across a Wrangler restart. The local AI binding is unavailable, so model completion was not verified; local Container startup also needs Docker.
- [ ] Create the requested GitHub repository and push after GitHub authentication is restored.
