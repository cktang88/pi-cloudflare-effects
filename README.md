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
              ├─ Code Mode: combines workspace, browser, web search, and MCP tools
              └─ Linux Container: optional commands and build tools
```

The main pieces have separate jobs:

- **Pi Durable** runs the model conversation and durable tasks. Its transcript and task tables live in the agent Durable Object's SQLite database.
- **Cloudflare Agents** supplies the Durable Object lifecycle, browser and MCP connections, and `PiHarness`, which stores Pi's data and wakes it to resume work after eviction or restart.
- **Cloudflare Code Mode** is one tool offered to Pi Durable. The model can write a short program that combines several tools in one sandbox run.
- **Computer** provides the persistent workspace and Artifacts Git. The Linux Container is separate; its filesystem is saved as a snapshot after commands and restored when needed.

Launched agents are separate Durable Objects. A `delegate` call creates a child conversation inside its parent's object, so it shares that agent's tools and workspace.

## Code Mode and Pi 1.0

This project uses **Cloudflare Code Mode**, created with `createCodeTool()` and adapted into a Pi Durable tool. It gives the model one `code_mode` tool with access to four groups:

- `workspace`: Computer file and shell tools
- `browser`: Cloudflare Browser tools
- `web`: Cloudflare Web Search
- `mcp`: tools from configured MCP servers

This is not Pi 1.0's built-in `codemode` extension. Pi Durable has its own extension and tool registration API; Pi's built-in extensions are not loaded automatically. The project also does not create Cloudflare's separate durable Code Mode runtime, which stores Code Mode execution history, approvals, and snippets. Pi Durable still persists the agent's conversation and tasks.

The Worker exports Cloudflare's `CodemodeRuntime` class for the Code Mode facet system, but the agent currently uses `DynamicWorkerExecutor` with `createCodeTool()`. See the [Pi changelog](https://pi.dev/changelog), [Pi Code Mode package](https://github.com/earendil-works/pi/blob/main/packages/codemode/README.md), and [Cloudflare Code Mode](https://github.com/cloudflare/agents/tree/main/packages/codemode).

Pi's lifecycle integration uses Cloudflare Agents' beta [`PiHarness`](https://developers.cloudflare.com/agents/harnesses/pi/). This owns the SQLite-backed Pi storage and recovery queue. The Worker keeps its HTTP API and tool extensions around that harness. Sessions from the earlier JSONL-backed implementation are not imported automatically.

## Capabilities

Each agent can:

- Continue its Pi Durable conversation and resume queued work after a Durable Object restart.
- Use `code_mode` to combine workspace, browser, web search, and MCP calls.
- Generate images through the Workers AI binding.
- Run commands in an on-demand Linux Container whose filesystem is snapshotted between commands.
- Delegate focused work to a durable child conversation.
- Create and use Git repositories through Cloudflare Artifacts.

Effect v4 spans and Cloudflare custom spans cover orchestration, agent runs, and tool calls. Wrangler invocation logs and traces are enabled in `wrangler.jsonc`; structured logs also record status changes, tool outcomes, errors, and durations.

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
- `AI_GATEWAY_ID`: AI Gateway ID for Web Search. Defaults to `default`.
- `MCP_SERVERS_JSON`: JSON array of MCP servers, each with a `name`, `url`, and optional `headers` object.

Example MCP value:

```json
[
  { "name": "docs", "url": "https://example.com/mcp" }
]
```

Store credentials in Wrangler secrets rather than in checked-in files. For example, set `MCP_SERVERS_JSON` with `npx wrangler secret put MCP_SERVERS_JSON`.

Deploy with `npx wrangler deploy`. The HTTP API does not add authentication; protect the Worker before exposing it publicly.

The repository's `.npmrc` allows fresh package releases. This setting applies only in this repository.

## Runtime Event Lab

The home page is a hands-on view of one agent run:

1. Launch the warehouse task. The agent writes a restock plan through its workspace tools.
2. Watch the live event log and final response. Events are also saved with the agent and replayed when its WebSocket reconnects.
3. Disconnect and reconnect the log socket while the durable task runs. The submitted PiHarness operation is separate from that viewer connection.
4. Arm a five-second durable deadline or trigger it immediately to abort the active Pi operation and inspect its terminal status.
5. Inject an OOM-like failure to exercise error reporting. This uses PiHarness abort; it does **not** cause a real Worker memory limit or process crash.

The **Brain** view shows the active Pi model, session tree, pending submissions, usage, and recent transcript. The **Hands** view shows registered tools, their configured replay policies, and current tool calls. Replay labels describe the tool policy; they do not predict which individual call is queued to replay. The views refresh while the log socket is connected. These inspection routes and the demo WebSocket work only from `localhost`; they do not expose transcript or tool state from a deployed Worker.

Cloudflare can terminate a Worker before application code records a true out-of-memory failure. To observe real restarts, keep a run active, restart `wrangler dev`, and reopen the page; the page remembers the agent ID locally and reconnects to the same persisted local Durable Object.

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
| `POST /agents/:id/interrupt` with `{"cause":"resource-limit"}` (localhost only) | Inject a labeled OOM-like failure and abort the active operation |
| `POST /agents/:id/deadline` with `{"seconds":5}` (localhost only) | Schedule a durable deadline for the active operation |
| WebSocket `/agents/pi-agent/:id` (localhost only) | Receive saved events and live lifecycle events |

Statuses are `idle`, `running`, `complete`, or `failed`. Prompts must be non-empty strings.
