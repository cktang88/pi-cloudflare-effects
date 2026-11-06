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
- [x] Pin Pi Durable 1.0, Effect 4, Cloudflare Agents 0.26, Computer, Code Mode, and supporting libraries.
- [x] Migrate Pi Durable registration to its 1.0 extension and registry APIs.
- [x] Launch each agent as an independent named `PiAgent` Durable Object and use Agents' first-party `PiHarness` for Pi storage and lifecycle recovery.
- [x] Add replay-safe task-owned Pi Durable child conversations for agent delegation.
- [x] Expose Computer, Browser, Web Search, MCP, and Artifacts through Cloudflare Code Mode.
- [x] Add durable workspace memory guidance and Workers AI image generation.
- [x] Restore Container snapshots on demand and save a new snapshot after each shell command.
- [x] Enable Cloudflare invocation logs and native custom spans; keep structured Effect span, status, and tool outcome logs.
- [x] Document current setup, local dependency age override, optional MCP service suggestions, and platform limits.
- [x] Verify `npm ci` and TypeScript using Node.js 24.19.
- [x] Run a clean install without `legacy-peer-deps`, typecheck, and Wrangler dry-run after migrating to the first-party PiHarness.
- [x] Upgrade to the releases current on 2026-11-06 (Pi Durable 1.5, Agents 0.33, Computer 0.10, Code Mode 0.5.6, Effect 4.1, AI SDK 7.0.163, Wrangler 4.158) and rework each integration to its current docs: pi-schema tool schemas and `output` results, `onWake`/`onReport`, `watch()` views instead of removed event streams, Agents' Pi `browser`/`web_search`/`web_fetch` tools, Computer's `tools/ai-sdk` and Cloudflare observer, Effect `ManagedRuntime`, `Schema.TaggedError`, and Schema-decoded input.
- [x] Local smoke run with Workers AI and Artifacts stubbed: launch, status, inspect, WebSocket view, run, and resume; the run ends `model_error` as expected without a model.
- [ ] Smoke-check PiHarness-backed submission and recovery against a working model binding. The local AI binding is unavailable; local Container startup also needs Docker.
- [x] Create and push the requested GitHub repository.
