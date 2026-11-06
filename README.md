# Pi Durable on Cloudflare

A Cloudflare Worker that launches persistent Pi Durable agents. Each top-level agent has its own named Durable Object, conversation, workspace, and resumable work.

## What runs where

```text
HTTP request
    └─ Orchestrator Durable Object
         ├─ remembers which agents were launched
         └─ one PiAgent Durable Object per agent
              ├─ Pi Durable: conversation, tasks, and child conversations
              ├─ Computer: files, shell tools, and Artifacts Git
              ├─ Code Mode: combines workspace, web, and MCP tools in one script
              ├─ Browser, Web Search, Web Fetch: Cloudflare Agents' Pi tools
              └─ Linux Container: optional commands and build tools
```

The main pieces have separate jobs:

- **Pi Durable** runs the model conversation and durable tasks. Its transcript and task tables live in the agent Durable Object's SQLite database.
- **Cloudflare Agents** supplies the Durable Object lifecycle, MCP connections, and `PiHarness`, which stores Pi's data and wakes it to resume work after eviction or restart. Its first-party Pi tools provide the persistent `browser` (a `Browser` lifecycle capability on Browser Run), `web_search`, and `web_fetch`.
- **Cloudflare Code Mode** is one tool offered to Pi Durable. The model can write a short program that combines several tools in one sandbox run.
- **Computer** provides the persistent workspace and Artifacts Git. The Linux Container is separate; its filesystem is saved as a snapshot after commands and restored when needed.

Launched agents are separate Durable Objects. A `delegate` call creates a child conversation inside its parent's object, so it shares that agent's tools and workspace.

## Code Mode and Pi Durable 1.5

This project uses **Cloudflare Code Mode**, created with `createCodeTool()` and registered as one Pi Durable tool, `code_mode`. Scripts run in a Dynamic Worker (`DynamicWorkerExecutor`) and can call three groups:

- `workspace`: Computer's AI SDK workspace tools (`createAITools` from `@cloudflare/computer/tools/ai-sdk`), including `exec` on the worker shell
- `web`: `search` and `fetch`, from `agents/websearch/ai-sdk` and `agents/webfetch/ai-sdk`
- `mcp`: tools from configured MCP servers

The browser is not in Code Mode: its tool already takes a CDP script, and Agents' `browserTool` for Pi gives each conversation its own tab.

This is not Pi's built-in durable `codemode` extension. On Cloudflare that extension needs a `RemoteCodemodeSandbox` in a separately deployed Worker; this project stays a single Worker. The Worker exports Cloudflare's `CodemodeRuntime` class for the Code Mode facet system, but the agent uses `DynamicWorkerExecutor` with `createCodeTool()`. See the [pi-durable README](https://github.com/earendil-works/pi/tree/main/packages/durable), [Pi Code Mode on Cloudflare](https://github.com/earendil-works/pi/blob/main/packages/codemode/README.md#usage-on-cloudflare-workers), and [Cloudflare Code Mode](https://github.com/cloudflare/agents/tree/main/packages/codemode).

Pi's lifecycle integration uses Cloudflare Agents' beta [`PiHarness`](https://developers.cloudflare.com/agents/harnesses/pi/). It owns the SQLite-backed Pi storage and recovery job; the factory passes its `onWake` to `Harness.open`, so the object can hibernate while Pi's tasks sleep. Tool parameters are JSON Schema built with `@earendil-works/pi-schema`. Pi's `onReport` reports (storage failures, interrupted or faulted tasks) are logged as `pi.report`.

`agents` 0.33 supports exactly one Pi minor (`~1.5.0`). Pi 1.5 stores conversations in a format Pi 1.4 cannot read, so roll a bad deploy forward rather than back.

## Capabilities

Each agent can:

- Continue its Pi Durable conversation and resume queued work after a Durable Object restart.
- Use `code_mode` to combine workspace, web search, web fetch, and MCP calls.
- Search and read the web with `web_search` and `web_fetch`, and drive a persistent browser with `browser`.
- Generate images through the Workers AI binding.
- Run commands in an on-demand Linux Container whose filesystem is snapshotted between commands.
- Delegate focused work to a durable child conversation.
- Create and use Git repositories through Cloudflare Artifacts.

Effect spans (run through one `ManagedRuntime` with a logging tracer) and Cloudflare custom spans cover orchestration, agent runs, and tool calls; Computer's Cloudflare observer adds workspace spans. Request bodies and `MCP_SERVERS_JSON` are decoded with Effect Schema. Wrangler invocation logs and traces are enabled in `wrangler.jsonc`; structured logs also record status changes, tool outcomes, errors, and durations.

## Run locally

Use Node.js 22.19+ or 24.11+.

The `config.dev` setting in `package.json` selects the runtime. With `true`, `npm run dev` runs the Worker locally and keeps bindings with no local simulator (Workers AI and Artifacts) remote. Browser, Durable Objects, Worker Loader, and Containers use local Wrangler support. Set it to `false` to run the Worker and all bindings remotely on Cloudflare.

```sh
npm ci
npm run dev
```

Open [http://localhost:8787](http://localhost:8787) for the Runtime Event Lab. It launches a real Pi Durable run for a small warehouse restock task. The local run needs the configured Workers AI binding to be available.

Wrangler bindings are declared in `wrangler.jsonc`. In local mode, Workers AI and Artifacts use Cloudflare because they have no local simulator; Browser, Durable Objects, Worker Loader, and Containers use local support. This local setup still needs Cloudflare login and a plan that supports remote Artifacts, and it uses real Workers AI, which can incur charges. Remote mode requires a plan that supports this project's Artifacts and Dynamic Workers features. Create or select the Cloudflare resources required by those bindings before deploying. The Artifacts namespace is set to `default` in the config; change it if your namespace has another name.

Optional settings:

- `MODEL_ID`: Workers AI model ID. Defaults to `@cf/zai-org/glm-5.3-flash`.
- `AI_GATEWAY_ID`: AI Gateway ID that bills Web Search. Defaults to `default`.
- `MCP_SERVERS_JSON`: JSON array of MCP servers, each with a `name`, `url`, and optional `headers` object.

Example MCP value:

```json
[
  { "name": "docs", "url": "https://example.com/mcp" }
]
```

Store credentials in Wrangler secrets rather than in checked-in files. For example, set `MCP_SERVERS_JSON` with `npx wrangler secret put MCP_SERVERS_JSON`.

Deploy with `npx wrangler deploy`. The HTTP API does not add authentication; protect the Worker before exposing it publicly.

The repository's `.npmrc` sets `min-release-age=0`, so fresh package releases install without a cooldown. This setting applies only in this repository. `package.json` has two overrides: `undici` inside `guarded-fetch` (pulled in by `just-bash`, which the worker shell needs) is raised to a patched 7.x release, and `ws` is held at 8.21.0, the exact optional peer Chord 1.5 declares, so `npm ci` accepts the lockfile.

## Runtime Event Lab

The home page is a hands-on view of one agent run:

1. Launch the warehouse task. The agent writes a restock plan through its workspace tools.
2. Watch the live event log and final response. The WebSocket sends Pi's conversation view (transcript window, streamed answer, running tools, and why a run ended unanswered) on every change; runtime events are also saved with the agent and replayed when the socket reconnects.
3. Disconnect and reconnect the log socket while the durable task runs. The submitted PiHarness operation is separate from that viewer connection.
4. Arm a five-second durable deadline or trigger it immediately. This calls `PiHarness.abort()` and ends the active operation.
5. Restart the Durable Object while the operation is pending. Pi Durable reopens its stored transcript and tasks, then continues the same operation; a model request cut off mid-answer counts as a failed attempt and is retried after Pi's backoff. Use **Resume run** to reconnect to that operation; it does not submit the prompt again.

The **Brain** view shows the active Pi model, session tree, live durable task graph, pending submissions, usage, compactions, the run's tool rounds or why it ended unanswered, and the recent transcript. The **Hands** view shows registered tools and replay policies, active and nested calls, completed calls, up to 100 durable workspace paths, attached Artifacts repositories, configured MCP endpoints, recent browser calls, and the Linux Container's snapshot state. Computer's Pi adapter exposes direct read-only workspace tools; Code Mode retains the multi-tool workspace, Browser, web-search, and MCP workflow. Replay labels describe each tool's configured policy; they do not predict which individual call is queued to replay. These inspection routes and the demo WebSocket work only from `localhost`; they do not expose transcript or tool state from a deployed Worker.

The restart experiment uses `DurableObjectState.abort()` to force an abrupt Durable Object restart; it does not allocate memory until an OOM occurs. If local Wrangler does not implement this API, set `config.dev` to `false` in `package.json` and run `npm run dev` to use Wrangler's remote preview. Pi Durable saves its conversation and task state in Durable Object storage. The model does not preserve hidden activations, so it may need another model call to continue from the saved point. Container files restore from the latest completed container snapshot; an interrupted command may need to be run again.

The demo stores up to 300 structured events per agent. Wrangler logs and traces remain enabled for request-level details.

## HTTP API

Start an agent:

```sh
curl -X POST http://localhost:8787/agents \
  -H 'content-type: application/json' \
  -d '{"prompt":"Inspect the project and summarize its structure."}'
```

The `202` response includes an `agentId` and `operationId`. The launch continues in the background.

| Request | Result |
| --- | --- |
| `POST /agents` with `{"prompt":"..."}` | Launch a new agent; returns its IDs |
| `GET /agents` | List launched agent IDs and creation times |
| `GET /agents/:id` | Read status and the latest response or error |
| `GET /agents/:id/events` (localhost only) | Read the agent's saved event history |
| `GET /agents/:id/inspect` (localhost only) | Inspect Pi Durable session state and tool registrations |
| `POST /agents/:id/run` with `{"prompt":"..."}` | Send a prompt to that agent and wait for its response |
| `POST /agents/:id/interrupt` with `{"cause":"deadline"}` (localhost only) | Abort the active PiHarness operation |
| `POST /agents/:id/interrupt` with `{"cause":"runtime-crash"}` (localhost only) | Force a Durable Object restart and let Pi Durable recover its pending operation |
| `POST /agents/:id/resume` (localhost only) | Reopen the Pi Durable session and reconnect to existing pending work without resubmitting a prompt |
| `POST /agents/:id/deadline` with `{"seconds":5}` (localhost only) | Schedule a durable deadline for the active operation |
| WebSocket `/agents/pi-agent/:id` (localhost only) | Receive saved events and live lifecycle events |

Statuses are `idle`, `running`, `complete`, or `failed`. Prompts must be non-empty strings.
