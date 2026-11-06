import { routeAgentRequest } from "agents";
import { Schema } from "effect";
import { errorMessage } from "./observability";
import { Orchestrator } from "./orchestrator";
import { DeadlineInput, InterruptInput, RunInput } from "./schemas";
import type { Env } from "./types";
import { PiAgent } from "./worker-agent";

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
			const input = await readBody(request, decodeRunInput);
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
				const input = await readBody(request, decodeRunInput);
				if (input instanceof Response) return input;
				return json(await orchestrator.runAgent(agentId, input.prompt));
			}

			if (request.method === "POST" && action === "interrupt") {
				const input = await readBody(request, decodeInterruptInput);
				if (input instanceof Response) return input;
				return json(await orchestrator.interruptDemoRun(agentId, input.cause));
			}

			if (request.method === "POST" && action === "resume") {
				return json(await orchestrator.resumeDemoRun(agentId));
			}

			if (request.method === "POST" && action === "deadline") {
				const input = await readBody(request, decodeDeadlineInput);
				if (input instanceof Response) return input;
				return json(await orchestrator.armDemoDeadline(agentId, input.seconds));
			}
		} catch (error) {
			return errorResponse(error);
		}

		return json({ error: "Not found" }, 404);
	},
} satisfies ExportedHandler<Env>;

const decodeRunInput = Schema.decodeUnknownSync(RunInput);
const decodeInterruptInput = Schema.decodeUnknownSync(InterruptInput);
const decodeDeadlineInput = Schema.decodeUnknownSync(DeadlineInput);

/** Parses a JSON body and decodes it with an Effect Schema; a bad body is a 400 with the decoder's message. */
async function readBody<A>(request: Request, decode: (input: unknown) => A): Promise<A | Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: "Body must be valid JSON" }, 400);
	}
	try {
		return decode(body);
	} catch (error) {
		return json({ error: errorMessage(error) }, 400);
	}
}

function isLocalDemoRequest(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status });
}

function errorResponse(error: unknown): Response {
	const message = errorMessage(error);
	console.error(JSON.stringify({ event: "request.failed", message }));
	return json({ error: message }, 500);
}
