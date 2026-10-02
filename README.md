# Pi Cloudflare Effects

A Cloudflare Worker that launches Pi Durable agents. Each agent runs the Pi Durable conversation and task runtime in its own Durable Object. Cloudflare Agents provides child-object launch, Browser and MCP connections, and a durable wake queue. Effect spans and Cloudflare Observability make runs visible.

## How it fits together

```text
POST /agents
    └─ Orchestrator Durable Object
         └─ one agent Durable Object per run
              ├─ Pi Durable conversation, tasks, submissions, and subagents
              ├─ Computer workspace + Artifacts Git
              ├─ Code Mode → Computer, Browser, Web Search, MCP
              └─ on-demand Linux Container + filesystem snapshots
```

Pi Durable is the agent runtime. The old Pi coding-agent runtime is not installed here. Pi Durable 1.0 does not share the 0.99 peer range still declared by `agents@0.25.0` for its experimental Pi harness, so the app opens Pi Durable directly over a durable file store and uses the Agents lifecycle queue to wake it. The repo-local `.npmrc` permits fresh package releases and skips that stale peer check; it does not affect global npm settings.

## Set up

1. Use Node.js 22.19+ or 24.11+.
2. Run `npm ci` and `npm run dev`.
3. Create a Cloudflare Artifacts namespace and change the `ARTIFACTS` namespace in `wrangler.jsonc` if it is not named `default`.
4. Add MCP connections by setting `MCP_SERVERS_JSON` to a JSON array of `{ "name", "url", "headers?" }` entries. Keep credentials in `headers` secrets, not in checked-in config.
5. Set `AI_GATEWAY_ID` if Web Search should use a named AI Gateway. `MODEL_ID` can select a Workers AI model supported by the Agents Pi AI provider.

Cloudflare's Web Search API is called through the Workers AI binding. The `BROWSER` binding supplies browser tools. The `LOADER` binding runs isolated Code Mode programs. The workspace exposes Computer files and Artifacts Git; the separate Container is for Linux commands and build tools.

The agent saves its Linux filesystem snapshot after each shell command, then stops the Container. Later commands restore that snapshot. The Pi Durable `delegate` tool creates task-owned child conversations that can use the same hands without creating another delegation layer. Cloudflare currently documents `durable_object` scheduling and snapshots as public beta. [Container release notes](https://blog.cloudflare.com/faster-agent-sandboxes/)

## API

```sh
curl -X POST http://localhost:8787/agents \
  -H 'content-type: application/json' \
  -d '{"prompt":"Inspect the project and summarize its structure."}'
```

The response contains `agentId` and `operationId`. Poll `GET /agents/:id` for durable status and the latest response. Send another prompt to the same conversation with `POST /agents/:id/run`. `GET /agents` lists launched agents.

## Operations

Worker logs include JSON status changes, tool outcomes, errors, and durations. A small Effect v4 tracer writes each span's name, trace and span IDs, outcome, and duration to Worker logs. `wrangler.jsonc` also enables Cloudflare invocation logs and traces. Cloudflare Traces follows a request across Cloudflare's platform, and the Observability release adds unified logs, traces, querying, dashboards, and telemetry export. [Cloudflare Traces](https://blog.cloudflare.com/cloudflare-tracing/) · [Cloudflare Observability](https://blog.cloudflare.com/one-observability-platform/)

Useful optional MCP connections include Cloudflare AI Search for a managed knowledge base and Cloudflare Observability for log/trace queries. Add either endpoint through `MCP_SERVERS_JSON`; this app does not need an additional client library for those services. Confirm each endpoint's current URL and authentication in its Cloudflare dashboard before adding it.

Pi 1.0's Codemode and MCP ideas are represented by Cloudflare Code Mode and the Agents MCP manager, registered as tools in Pi Durable. Pi's standalone Codemode package uses Node worker threads and cannot run in this Worker environment. The `generate_image` tool uses the Agents Workers AI image adapter; pass a Workers AI image model ID and prompt. [Pi 1.0 release notes](https://pi.dev/changelog/releases/1.0.0)

The workspace uses Cloudflare Artifacts Git, so agents can create repositories, commit files, and hand work off through the Artifacts API. Cloudflare has also announced Workers Builds from Artifacts pushes and preview deployments. [Cloudflare Git platform announcement](https://blog.cloudflare.com/next-git-platform-on-cloudflare/)
