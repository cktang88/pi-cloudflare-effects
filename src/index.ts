import { routeAgentRequest } from "agents";
import { Schema } from "effect";
import { errorMessage } from "./observability";
import { Orchestrator } from "./orchestrator";
import { ANSWER_MAX, AnswerInput, DeadlineInput, ForkInput, HISTORY_MAX, InterruptInput, LaunchInput, McpReconnectInput, MessageInput, NOTE_MAX, RunInput } from "./schemas";
import { isRequestFailure, type Env } from "./types";
import { PiAgent } from "./worker-agent";

export { Orchestrator, PiAgent };
// Code Mode's runtime (`createCodemodeRuntime`) stores its call log in this class; it finds it through ctx.exports.
export { CodemodeRuntime } from "@cloudflare/codemode";
// The worker shell calls back into the agent's Workspace through this class, found through ctx.exports.
export { WorkspaceServiceProxy } from "@cloudflare/computer";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (request.headers.get("Upgrade")?.toLowerCase() === "websocket" && /^\/agents\/pi-agent\/[a-f0-9-]+$/.test(url.pathname)) {
			if (!isLocalDemoRequest(url.hostname)) return json({ error: "Demo inspection is available on localhost only" }, 403);
			const response = await routeAgentRequest(request, env);
			if (response) return response;
		}
		const orchestrator = env.ORCHESTRATOR.get(env.ORCHESTRATOR.idFromName("main"));

		// Cross-site POSTs are refused. A JSON content type also forces a CORS preflight, which this
		// Worker never answers, so a page on another site can't launch or steer an agent through a
		// visitor's browser (for example against a local `wrangler dev`).
		if (request.method === "POST") {
			if (request.headers.get("Sec-Fetch-Site") === "cross-site") return json({ error: "Cross-site requests are not allowed" }, 403);
			if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
				return json({ error: "Send the body as application/json" }, 415);
			}
		}

		if (url.pathname === "/agents" && request.method === "POST") {
			const input = await readBody(request, decodeLaunchInput);
			if (input instanceof Response) return input;
			if ((input.history?.length ?? 0) > HISTORY_MAX) return json({ error: `history can have at most ${HISTORY_MAX} messages` }, 400);
			if (input.history?.length && input.history[0]?.role !== "user") return json({ error: "history must start with a user message" }, 400);
			try {
				return json(await orchestrator.launch(input.prompt, {
					...(input.history?.length ? { history: input.history } : {}),
					...(input.approvals !== undefined ? { approvals: input.approvals } : {}),
					...(input.replyMinutes !== undefined ? { replyMinutes: input.replyMinutes } : {}),
				}), 202);
			} catch (error) {
				return errorResponse(error, url.hostname);
			}
		}

		if (url.pathname === "/agents" && request.method === "GET") {
			try {
				return json({ agents: await orchestrator.listAgents() });
			} catch (error) {
				return errorResponse(error, url.hostname);
			}
		}

		const match = /^\/agents\/([a-f0-9-]+)(?:\/(run|events|inspect|interrupt|deadline|resume|message|continue|fork|answer|mcp-reconnect))?$/.exec(url.pathname);
		if (!match) return json({ error: "Not found" }, 404);
		const [, agentId, action] = match;
		if (action && action !== "run" && !isLocalDemoRequest(url.hostname)) {
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

			if (request.method === "POST" && action === "message") {
				const input = await readBody(request, decodeMessageInput);
				if (input instanceof Response) return input;
				return reply(await orchestrator.sendMessage(agentId, input.prompt, { mode: input.mode, keep: input.keep }), 202);
			}

			if (request.method === "POST" && action === "continue") {
				return reply(await orchestrator.continueRun(agentId), 202);
			}

			if (request.method === "POST" && action === "fork") {
				const input = await readBody(request, decodeForkInput);
				if (input instanceof Response) return input;
				if ((input.note?.length ?? 0) > NOTE_MAX) return json({ error: `note can have at most ${NOTE_MAX} characters` }, 400);
				return reply(await orchestrator.forkSession(agentId, input.prompt?.trim() || undefined, input.note?.trim() || undefined), 202);
			}

			if (request.method === "POST" && action === "answer") {
				const input = await readBody(request, decodeAnswerInput);
				if (input instanceof Response) return input;
				const limit = input.decision ? NOTE_MAX : ANSWER_MAX;
				if ((input.text?.trim().length ?? 0) > limit) return json({ error: `text can have at most ${limit} characters` }, 400);
				return reply(await orchestrator.answerWait(agentId, input.key, {
					...(input.text !== undefined ? { text: input.text } : {}),
					...(input.decision ? { decision: input.decision } : {}),
				}));
			}

			if (request.method === "POST" && action === "mcp-reconnect") {
				const input = await readBody(request, decodeMcpReconnectInput);
				if (input instanceof Response) return input;
				return reply(await orchestrator.reconnectMcp(agentId, input.serverId));
			}

			if (request.method === "POST" && action === "deadline") {
				const input = await readBody(request, decodeDeadlineInput);
				if (input instanceof Response) return input;
				return json(await orchestrator.armDemoDeadline(agentId, input.seconds));
			}
		} catch (error) {
			return errorResponse(error, url.hostname);
		}

		return json({ error: "Not found" }, 404);
	},
} satisfies ExportedHandler<Env>;

const decodeRunInput = Schema.decodeUnknownSync(RunInput);
const decodeLaunchInput = Schema.decodeUnknownSync(LaunchInput);
const decodeMessageInput = Schema.decodeUnknownSync(MessageInput);
const decodeForkInput = Schema.decodeUnknownSync(ForkInput);
const decodeAnswerInput = Schema.decodeUnknownSync(AnswerInput);
const decodeMcpReconnectInput = Schema.decodeUnknownSync(McpReconnectInput);
const decodeInterruptInput = Schema.decodeUnknownSync(InterruptInput);
const decodeDeadlineInput = Schema.decodeUnknownSync(DeadlineInput);

/** Parses a JSON body and checks it with an Effect Schema. A bad body gets a 400 with the schema's message. */
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

/** null is an unknown agent; a RequestFailure carries its own status. */
function reply(value: unknown, status = 200): Response {
	if (value === null) return json({ error: "Agent not found" }, 404);
	if (isRequestFailure(value)) return json({ error: value.error }, value.status);
	return json(value, status);
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status });
}

/** Logs the full error; only the local Event Lab gets the message, like Agents 0.34's Lifecycle.fetch. */
function errorResponse(error: unknown, hostname: string): Response {
	const message = errorMessage(error);
	console.error(JSON.stringify({ event: "request.failed", message }));
	return json({ error: isLocalDemoRequest(hostname) ? message : "Internal Server Error" }, 500);
}
