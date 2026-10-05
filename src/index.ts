import type { Env, RunInput } from "./types";
import type { DemoInterrupt } from "./types";
import { Orchestrator } from "./orchestrator";
import { PiAgent } from "./worker-agent";
import { routeAgentRequest } from "agents";

export { Orchestrator, PiAgent };
export { CodemodeRuntime } from "@cloudflare/codemode";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (request.headers.get("Upgrade")?.toLowerCase() === "websocket" && /^\/agents\/pi-agent\/[a-f0-9-]+$/.test(url.pathname)) {
			if (!isLocalDemoRequest(url.hostname)) return json({ error: "Demo inspection is available on localhost only" }, 403);
			const response = await routeAgentRequest(request, env);
			if (response) return response;
		}
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

		const match = /^\/agents\/([a-f0-9-]+)(?:\/(run|events|inspect|interrupt|deadline|resume))?$/.exec(url.pathname);
		if (!match) return json({ error: "Not found" }, 404);
		const [, agentId, action] = match;
		if ((action === "events" || action === "inspect" || action === "interrupt" || action === "deadline" || action === "resume") && !isLocalDemoRequest(url.hostname)) {
			return json({ error: "Demo inspection is available on localhost only" }, 403);
		}

		try {
			if (request.method === "GET" && !action) {
				const status = await orchestrator.getAgentStatus(agentId);
				return status ? json(status) : json({ error: "Agent not found" }, 404);
			}

			if (request.method === "GET" && action === "events") {
				const events = await orchestrator.getAgentEvents(agentId);
				return events ? json({ events }) : json({ error: "Agent not found" }, 404);
			}

			if (request.method === "GET" && action === "inspect") {
				const inspection = await orchestrator.inspectAgent(agentId);
				return inspection ? json(inspection) : json({ error: "Agent not found" }, 404);
			}

			if (request.method === "POST" && action === "run") {
				const input = await readInput(request);
				if (input instanceof Response) return input;
				return json(await orchestrator.runAgent(agentId, input.prompt));
			}

			if (request.method === "POST" && action === "interrupt") {
				const cause = await readInterrupt(request);
				if (cause instanceof Response) return cause;
				return json(await orchestrator.interruptDemoRun(agentId, cause));
			}

			if (request.method === "POST" && action === "resume") {
				return json(await orchestrator.resumeDemoRun(agentId));
			}

			if (request.method === "POST" && action === "deadline") {
				const seconds = await readDeadline(request);
				if (seconds instanceof Response) return seconds;
				return json(await orchestrator.armDemoDeadline(agentId, seconds));
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

function isLocalDemoRequest(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

async function readInterrupt(request: Request): Promise<DemoInterrupt | Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: "Body must be valid JSON" }, 400);
	}
	if (!body || typeof body !== "object" || !("cause" in body) || (body.cause !== "deadline" && body.cause !== "runtime-crash")) {
		return json({ error: "cause must be deadline or runtime-crash" }, 400);
	}
	return body.cause;
}

async function readDeadline(request: Request): Promise<number | Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: "Body must be valid JSON" }, 400);
	}
	if (!body || typeof body !== "object" || !("seconds" in body) || typeof body.seconds !== "number" || !Number.isInteger(body.seconds) || body.seconds < 1 || body.seconds > 300) {
		return json({ error: "seconds must be an integer from 1 to 300" }, 400);
	}
	return body.seconds;
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status });
}

function errorResponse(error: unknown): Response {
	const message = error instanceof Error ? error.message : String(error);
	console.error(JSON.stringify({ event: "request.failed", message }));
	return json({ error: message }, 500);
}
