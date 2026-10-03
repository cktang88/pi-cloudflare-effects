import type { Env, RunInput } from "./types";
import { Orchestrator } from "./orchestrator";
import { PiAgent } from "./worker-agent";

export { Orchestrator, PiAgent };
export { CodemodeRuntime } from "@cloudflare/codemode";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const orchestrator = env.ORCHESTRATOR.get(env.ORCHESTRATOR.idFromName("main"));

		if (url.pathname === "/agents" && request.method === "POST") {
			const input = await readInput(request);
			if (input instanceof Response) return input;
			try {
				return json(await orchestrator.launch(input.prompt), 202);
			} catch (error) {
				return errorResponse(error);
			}
		}

		if (url.pathname === "/agents" && request.method === "GET") {
			return json({ agents: await orchestrator.listAgents() });
		}

		const match = /^\/agents\/([a-f0-9-]+)(?:\/run)?$/.exec(url.pathname);
		if (!match) return json({ error: "Not found" }, 404);
		const [, agentId] = match;

		try {
			if (request.method === "GET" && !url.pathname.endsWith("/run")) {
				const status = await orchestrator.getAgentStatus(agentId);
				return status ? json(status) : json({ error: "Agent not found" }, 404);
			}

			if (request.method === "POST" && url.pathname.endsWith("/run")) {
				const input = await readInput(request);
				if (input instanceof Response) return input;
				return json(await orchestrator.runAgent(agentId, input.prompt));
			}
		} catch (error) {
			return errorResponse(error);
		}

		return json({ error: "Not found" }, 404);
	},
} satisfies ExportedHandler<Env>;

async function readInput(request: Request): Promise<RunInput | Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: "Body must be valid JSON" }, 400);
	}
	if (!body || typeof body !== "object" || !("prompt" in body) || typeof body.prompt !== "string" || !body.prompt.trim()) {
		return json({ error: "prompt must be a non-empty string" }, 400);
	}
	return { prompt: body.prompt.trim() };
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status });
}

function errorResponse(error: unknown): Response {
	const message = error instanceof Error ? error.message : String(error);
	console.error(JSON.stringify({ event: "request.failed", message }));
	return json({ error: message }, 500);
}
