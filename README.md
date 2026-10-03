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

- **Pi Durable** runs the model conversation and durable tasks. Its session files use the agent Durable Object's storage.
- **Cloudflare Agents** supplies the Durable Object lifecycle, browser and MCP connections, and the wake queue used to resume Pi Durable work.
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

```sh
npm ci
npx wrangler dev
```

Wrangler bindings are declared in `wrangler.jsonc`: Durable Objects, Workers AI, Browser, Worker Loader, Containers, and Artifacts. Create or select the Cloudflare resources required by those bindings before deploying. The Artifacts namespace is set to `default` in the config; change it if your namespace has another name.

Optional settings:

- `MODEL_ID`: Workers AI model ID. Defaults to `@cf/zai-org/glm-4.7-flash`.
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

The repository's `.npmrc` allows fresh package releases and skips the incompatible peer check between Agents' experimental Pi harness and Pi Durable 1.0. These settings apply only in this repository.

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
| `POST /agents/:id/run` with `{"prompt":"..."}` | Send a prompt to that agent and wait for its response |

Statuses are `idle`, `running`, `complete`, or `failed`. Prompts must be non-empty strings.
