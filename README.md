# Pi Cloudflare Effects

A Cloudflare Worker that launches durable Pi agents. Each agent keeps its Pi session and status in a Durable Object, and has a Computer workspace, browser tools, Web Search, MCP connections, and a resumable Linux sandbox.

## Set up

1. Create a Cloudflare Artifacts namespace and update the `ARTIFACTS` namespace in `wrangler.jsonc` if it is not named `default`.
2. When remote MCP servers are needed, set the `MCP_SERVERS_JSON` secret to a JSON array of `{ "name", "url", "headers?" }` entries.
3. Use Node.js 22.18+ or 24.11+, run `npm install`, then `npm run dev`.

The workspace shell exposes Computer's files and Artifacts commands. `container_exec` runs build and system commands in a separate Linux filesystem; that filesystem is snapshotted between runs. Agents can use Artifacts repositories as the Git handoff between the workspace and sandbox.

Cloudflare's `durable_object` container scheduling policy and filesystem snapshots are in public beta. Container execution currently allows outbound internet access so agents can fetch packages and sources.

`POST /agents` accepts `{ "prompt": "..." }` and immediately returns an agent ID and operation ID. Poll `GET /agents/:id` for its status and response.
