# Pi Durable on Cloudflare

A Cloudflare Worker that starts Pi Durable agents. Each agent gets its own Durable Object, which holds its conversation, workspace files, and any unfinished work, so the agent picks up where it stopped after a restart.

## What runs where

```text
HTTP request
    └─ Orchestrator Durable Object
         ├─ keeps the list of agents
         └─ one PiAgent Durable Object per agent
              ├─ Pi Durable: the conversation, its tasks, and subagent conversations
              ├─ Computer: workspace files, a shell, git, and Artifacts repositories
              ├─ Code Mode: one script that calls workspace, web, and MCP tools
              ├─ browser, web_search, web_fetch: tools from Cloudflare Agents
              └─ Linux container: for commands the shell can't run
```

- **Pi Durable** runs the model and its tool calls. It saves the transcript and tasks in the agent's SQLite database.
- **Cloudflare Agents** provides the Durable Object base class, MCP connections, and `PiHarness`. `PiHarness` gives Pi its storage and sets an alarm so Pi resumes after the object is evicted or restarts. Agents also supplies the `browser`, `web_search`, and `web_fetch` tools for Pi.
- **Code Mode** (Cloudflare's) is one tool, `code_mode`. The model writes a short script that calls several tools in one sandboxed run.
- **Computer** provides the workspace: files stored in the Durable Object, a shell, git, and Artifacts. The Linux container is separate. Its filesystem is saved as a snapshot after each command and restored on the next one.

Each agent started over HTTP is its own Durable Object. The `delegate` tool starts a subagent as a child conversation in the same object, so it shares the parent's tools and workspace.

## How the pieces fit

### Pi Durable and PiHarness

`PiHarness` is in beta ([docs](https://developers.cloudflare.com/agents/harnesses/pi/)). The agent gives it a function that opens Pi. That function installs the tools and system prompt, and passes `PiHarness`'s `onWake` to `Harness.open`, so the object can sleep while Pi waits on a retry. Tool parameters are JSON Schema built with `@earendil-works/pi-schema`. Pi's error reports (storage failures, tasks that crashed or were cut off) are logged as `pi.report`.

`agents` 0.33 works with Pi 1.5 only. Pi 1.5 saves conversations in a format Pi 1.4 can't read, so fix a bad deploy by deploying forward, not by rolling back.

### Workspace tools

Computer's workspace tools (`read`, `ls`, `find`, `grep`, `write`, `edit`, `delete`, `exec`) are given to Pi directly, as in the [Agents Pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi). If a restart interrupts a call, Pi runs reads, `write`, and `delete` again; `edit` and `exec` return an "interrupted" result instead, because running them twice could change files twice.

`exec` runs in Computer's worker shell, which reaches the agent's files through the `WorkspaceServiceProxy` class the Worker exports and the agent's `__getWorkspaceStub()` method.

### Code Mode

`code_mode` uses Code Mode's runtime (`createCodemodeRuntime`) and runs each script with `runtime.execute({ code })`, the entry point Code Mode documents for apps that don't use the AI SDK. Scripts run in a Dynamic Worker with no network access. Every tool call a script makes is recorded by the `CodemodeRuntime` Durable Object facet, which the Worker exports. Instead of listing every method in the tool description, scripts look methods up with `codemode.search()` and `codemode.describe()`.

A script can call:

- `workspace.*`: the same workspace tools listed above. Reads are re-run rather than stored when a script resumes.
- `web.search` and `web.fetch`, built on Agents' `createAIWebSearch` and `fetchWeb`
- one object per configured MCP server, using the agent's live MCP connection

Code Mode's built-in AI SDK adapter (`ToolSetConnector`) calls tools without the options argument that Computer's `exec` and Agents' web tools read, so the `workspace` and `web` connectors are written on Code Mode's base connector class.

The browser isn't in Code Mode. Its tool input is already a script (Chrome DevTools Protocol calls), and each conversation gets its own tab.

This is Cloudflare's Code Mode, not Pi's own `codemode` extension. On Cloudflare, Pi's version needs a sandbox in a second, separately deployed Worker, and this project is one Worker. See the [pi-durable README](https://github.com/earendil-works/pi/tree/main/packages/durable), [Pi Code Mode on Cloudflare](https://github.com/earendil-works/pi/blob/main/packages/codemode/README.md#usage-on-cloudflare-workers), and [Cloudflare Code Mode](https://github.com/cloudflare/agents/tree/main/packages/codemode).

### Logs and traces

Agent runs and launches, tool calls, and the orchestrator's launch, run, status, and list calls each run inside a Cloudflare custom span and an Effect span. Effect spans are written to the log as JSON when they end. Computer adds spans for workspace operations. Request bodies and `MCP_SERVERS_JSON` are checked with Effect Schema. Wrangler invocation logs and traces are turned on in `wrangler.jsonc`.

## What an agent can do

- Keep its conversation across restarts and finish work that was in progress.
- Read and change workspace files, run shell commands, and use git and Artifacts repositories.
- Search the web, read pages, and drive a browser that stays open between turns.
- Run `code_mode` scripts that combine workspace, web, and MCP calls.
- Generate images with Workers AI.
- Run commands in a Linux container.
- Hand a focused task to a subagent with `delegate`.

## Run locally

Use Node.js 22.19+ or 24.11+.

`config.dev` in `package.json` picks where the Worker runs. With `true`, `npm run dev` runs it locally. Workers AI and Artifacts have no local version, so those bindings still call Cloudflare; Browser, Durable Objects, Worker Loader, and Containers run locally. With `false`, the Worker and all bindings run on Cloudflare.

```sh
npm ci
npm run dev
```

Open [http://localhost:8787](http://localhost:8787) for the Event Lab, which runs a small warehouse restock task.

Local mode still needs a Cloudflare login and a plan that includes Artifacts, and model calls use real Workers AI, which can cost money. Remote mode also needs a plan that includes Dynamic Workers. Create the resources the bindings in `wrangler.jsonc` refer to before you deploy. The Artifacts namespace is `default`; change it in `wrangler.jsonc` if yours has another name. Local containers need Docker.

Optional settings:

- `MODEL_ID`: Workers AI model ID. Default: `@cf/zai-org/glm-5.3-flash`.
- `AI_GATEWAY_ID`: the AI Gateway that Web Search is billed through. Default: `default`.
- `MCP_SERVERS_JSON`: a JSON array of MCP servers, each with a `name`, a `url`, and optional `headers`. The agent adds them each time it starts; adding a server that's already there does nothing. Agents saves the connections and reconnects them after a restart.

Example `MCP_SERVERS_JSON`:

```json
[
  { "name": "docs", "url": "https://example.com/mcp" }
]
```

Keep credentials in Wrangler secrets, not in files you commit: `npx wrangler secret put MCP_SERVERS_JSON`.

Deploy with `npx wrangler deploy`. The HTTP API has no authentication, so put access control in front of the Worker before you make it public.

This repository's `.npmrc` sets `min-release-age=0`, so npm installs new releases right away. It applies only here. `package.json` has two overrides:

- `undici` inside `guarded-fetch` is raised to a patched 7.x release. `guarded-fetch` comes from `just-bash`, which the worker shell needs.
- `ws` is pinned to 8.21.0, the exact version Chord 1.5 asks for, so `npm ci` accepts the lockfile.

## Event Lab

The home page runs one agent and shows what it does:

1. Start the warehouse task. The agent writes a restock plan to the workspace.
2. Watch the event log and the answer. The page's WebSocket receives Pi's conversation state (recent transcript, the answer as it streams, running tools, and why a run ended without an answer) every time it changes. The agent also saves its last 300 events and sends them again when the page reconnects.
3. Disconnect the page while the run is going, then reconnect. The run doesn't depend on the page.
4. Schedule an abort five seconds out, or abort now. Both call `PiHarness.abort()`. The scheduled abort is saved with the agent, so it still fires after a restart.
5. Restart the Durable Object mid-run. Pi reloads the saved conversation and continues the same run. A model answer that was cut off mid-stream counts as a failed attempt and is retried after Pi's backoff. **Resume run** checks that Pi still has the run and reconnects the page; it doesn't send the prompt again.

The **Model** tab shows the model, sessions, running tasks, queued prompts, token usage, context compactions, how many tool rounds the current run has taken (or why the last one ended without an answer), and the recent transcript. The **Tools** tab shows each tool and whether it may run again after a restart, calls in progress (including calls made from `code_mode`), finished calls, up to 100 workspace paths, Artifacts repositories, MCP servers and their connection state, recent browser calls, and the container snapshot. Whether a particular interrupted call actually runs again depends on where the restart cut it off.

The inspection routes and the WebSocket only answer requests to `localhost`, so a deployed Worker doesn't expose transcripts or tool state.

The restart button calls `DurableObjectState.abort()`, which restarts the object without using up memory. If local Wrangler doesn't support it, set `config.dev` to `false` and run `npm run dev` to try it on Cloudflare. The model has no memory of its own between calls, so after a restart it may need one more model call to continue. Container files come back from the last finished snapshot, so a command that was interrupted may need to run again.

Pi's conversation watches live in memory. When the object wakes from hibernation, it starts a new watch for each open WebSocket, and it starts another if Pi reopens after an error.

## HTTP API

Start an agent:

```sh
curl -X POST http://localhost:8787/agents \
  -H 'content-type: application/json' \
  -d '{"prompt":"Inspect the project and summarize its structure."}'
```

The `202` response has an `agentId` and an `operationId`. The run continues after the response is sent.

| Request | Result |
| --- | --- |
| `POST /agents` with `{"prompt":"..."}` | Start a new agent and return its IDs |
| `GET /agents` | List agent IDs and when they were created |
| `GET /agents/:id` | Status, and the latest answer or error |
| `GET /agents/:id/events` (localhost only) | The agent's saved events |
| `GET /agents/:id/inspect` (localhost only) | The data behind the Model and Tools tabs |
| `POST /agents/:id/run` with `{"prompt":"..."}` | Send a prompt and wait for the answer |
| `POST /agents/:id/interrupt` with `{"cause":"deadline"}` (localhost only) | Abort the current run |
| `POST /agents/:id/interrupt` with `{"cause":"runtime-crash"}` (localhost only) | Restart the Durable Object; Pi continues the current run |
| `POST /agents/:id/resume` (localhost only) | Report whether Pi still has the current run in progress; doesn't resend the prompt |
| `POST /agents/:id/deadline` with `{"seconds":5}` (localhost only) | Abort the current run after that many seconds (1 to 300) |
| WebSocket `/agents/pi-agent/:id` (localhost only) | Saved events, then live events and conversation state |

Statuses are `idle`, `running`, `complete`, and `failed`. Prompts must be non-empty strings.
