import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createAITools } from "@cloudflare/computer/tools";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import { configure, createRegistry, defineExtension, defineTool, Harness, section, type EntryRecord, type ToolRegistration } from "@earendil-works/pi-durable";
import { Agent as DurableAgent, type AgentContext, type Connection } from "agents";
import { PiHarness, type PiHarnessContext } from "agents/harness/pi";
import { createBrowserTools } from "agents/browser/ai";
import { createAI } from "agents/models/pi-ai";
import { tool } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import { withCloudflareSpan, withObservability } from "./observability";
import type { AgentEvent, AgentInspection, AgentStatus, DemoInterrupt, Env } from "./types";

const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";
const CORE_EXTENSION = "cloudflare-agent-tools";
const SUBAGENT_EXTENSION = "durable-subagents";
const SYSTEM_PROMPT = `You are a careful, resourceful agent running on Pi Durable. Your conversation, tasks, and submissions are durable and resumable. You have a persistent workspace, a resumable Linux sandbox, web search, browser access, and connected MCP tools. Use code_mode to combine short multi-step tool work. Keep durable facts that will help future runs in /memory.md in the workspace. Work in small verified steps, and report important actions and errors clearly.`;

type AiTool = {
	description?: string;
	inputSchema: z.ZodType;
	execute?: (args: Record<string, unknown>, options: { toolCallId: string; messages: [] }) => Promise<unknown>;
};

export class PiAgent extends DurableAgent<Env> {
	private mcpServersAdded = false;
	private nestedToolGroups: AgentInspection["hands"]["nestedTools"] = [];
	readonly ai = createAI({ binding: this.env.AI });
	readonly registry = createRegistry();
	readonly workspace = new Workspace({
		storage: this.ctx.storage as unknown as import("@cloudflare/computer").DurableObjectStorageLike,
		artifacts: { binding: this.env.ARTIFACTS, sessionId: this.ctx.id.toString() },
		git: createGitClient(),
		defaultGitIdentity: { name: "Pi Agent", email: "pi-agent@invalid.local" },
		backends: [
			new WorkerShellBackend({
				id: "shell",
				loader: this.env.LOADER,
				workspace: { binding: "PI_AGENT", id: this.ctx.id.toString() },
				ctx: this.ctx,
			}),
		],
	});
	readonly piHarness: PiHarness;

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.piHarness = new PiHarness({
			harness: (context) => this.createRuntime(context),
			defaults: { model: this.ai(this.env.MODEL_ID ?? DEFAULT_MODEL) },
		});
		this.lifecycle.use(this.piHarness);
	}

	async onStart(): Promise<void> {
		if (!(await this.ctx.storage.get<AgentStatus>("agent:status"))) {
			await this.saveStatus({ status: "idle" });
		}
	}

	async onConnect(connection: Connection): Promise<void> {
		for (const event of await this.getEvents()) connection.send(JSON.stringify(event));
		await this.recordEvent("client.connected", { connectionId: connection.id });
	}

	async onMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
		if (message === "ping") connection.send("pong");
	}

	async onClose(connection: Connection, code: number, reason: string, wasClean: boolean): Promise<void> {
		await this.recordEvent("client.disconnected", {
			connectionId: connection.id,
			code,
			reason: reason.slice(0, 120),
			wasClean,
		}, wasClean ? "info" : "warn");
	}

	async onError(connectionOrError: Connection | unknown, error?: unknown): Promise<void> {
		const cause = error ?? connectionOrError;
		await this.recordEvent("agent.websocket.error", {
			message: cause instanceof Error ? cause.message : String(cause),
		}, "error");
	}

	private async connectMcpServers(): Promise<void> {
		if (this.mcpServersAdded) return;
		for (const server of parseMcpServers(this.env.MCP_SERVERS_JSON)) {
			await this.addMcpServer(server.name, server.url, server.headers ? { transport: { headers: server.headers } } : undefined);
		}
		this.mcpServersAdded = true;
	}

	async run(prompt: string): Promise<{ text: string }> {
		const program = Effect.tryPromise({
			try: async () => {
				const operationId = crypto.randomUUID();
				await this.saveStatus({ status: "running", operationId });
				const result = await this.piHarness.prompt(prompt, { operationId });
				if (result.status !== "done") throw new Error(result.reason ?? "Pi Durable conversation did not complete");
				const text = result.text ?? "";
				await this.saveSandbox();
				await this.saveStatus({ status: "complete", lastResponse: text });
				return { text };
			},
			catch: (cause) => new Error("Pi Durable run failed", { cause }),
		}).pipe(
			Effect.withSpan("agent.run", { attributes: { agentId: this.ctx.id.toString() } }),
			withObservability,
		);
		try {
			return await withCloudflareSpan("agent.run", { "agent.id": this.name }, () => Effect.runPromise(program));
		} catch (error) {
			try {
				await this.saveSandbox();
			} catch (snapshotError) {
				console.error(JSON.stringify({ event: "sandbox.snapshot.failed", agentId: this.ctx.id.toString(), error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError) }));
			}
			await this.saveStatus({ status: "failed", lastError: error instanceof Error ? error.message : String(error) });
			throw error;
		}
	}

	async launch(prompt: string): Promise<{ operationId: string }> {
		return withCloudflareSpan("agent.launch", { "agent.id": this.name }, async () => {
			const operationId = crypto.randomUUID();
			await this.saveStatus({ status: "running", operationId });
			try {
				await this.piHarness.submit(prompt, { operationId });
			} catch (error) {
				await this.saveStatus({ status: "failed", lastError: error instanceof Error ? error.message : String(error) });
				throw error;
			}
			return { operationId };
		});
	}

	private async createRuntime({ storage, context }: PiHarnessContext): Promise<Harness> {
		await this.connectMcpServers();
		await this.mcp.waitForConnections({ timeout: 10_000 });
		const models = createModels();
		models.setProvider(this.ai.provider);
		const computerTools = createAITools({ workspace: this.workspace, shell: {
			defaultBackend: "shell",
			backends: { shell: { description: "Persistent workspace files and Artifacts Git repositories." } },
		} });
		const browserTools = createBrowserTools({ ctx: this.ctx, browser: this.env.BROWSER, loader: this.env.LOADER, session: { mode: "dynamic" } });
		const mcpTools = this.mcp.getAITools();
		const webSearch = tool({
			description: "Search the live web for current facts and sources.",
			inputSchema: z.object({ query: z.string().min(1).max(1024), limit: z.number().int().min(1).max(10).optional() }),
			execute: async ({ query, limit }) => {
				const response = await this.env.AI.websearch({ gatewayId: this.env.AI_GATEWAY_ID ?? "default", query, limit: limit ?? 5 });
				return response.json();
			},
		});
		this.nestedToolGroups = [
			...describeToolSet("workspace", computerTools),
			...describeToolSet("browser", browserTools),
			...describeToolSet("mcp", mcpTools),
			{ group: "web", name: "search", description: "Search the live web for current facts and sources." },
		];
		const codeMode = createCodeTool({
			tools: [
				{ name: "workspace", tools: computerTools },
				{ name: "browser", tools: browserTools },
				{ name: "mcp", tools: mcpTools },
				{ name: "web", tools: { search: webSearch } },
			],
			executor: new DynamicWorkerExecutor({ loader: this.env.LOADER }),
		});
		const tools: ToolRegistration[] = [
			...toPiTools({ code_mode: codeMode }),
			{
				name: "generate_image",
				description: "Generate an image with a Workers AI image model and return it in the conversation.",
				parameters: Type.Object({ modelId: Type.String({ minLength: 1, maxLength: 200 }), prompt: Type.String({ minLength: 1, maxLength: 4_000 }) }),
				replay: "unsafe",
				execute: async (args) => traceTool("generate_image", async () => {
					const { modelId, prompt } = args as { modelId: string; prompt: string };
					const result = await this.ai.generateImages(this.ai.images(modelId), { input: [{ type: "text", text: prompt }] });
					if (result.stopReason === "error") throw new Error(result.errorMessage ?? "Image generation failed");
					return { content: result.output, usage: result.usage };
				}),
			},
			{
				name: "container_exec",
				description: "Run a command in this agent's resumable Linux sandbox. Its filesystem is separate from the durable workspace.",
				parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16_384 }) }),
				executionMode: "sequential",
				replay: "unsafe",
				execute: async (args) => ({ content: [{ type: "text", text: await traceTool("container_exec", () => this.runInContainer((args as { command: string }).command)) }] }),
			},
		];
		const coreExtension = defineExtension({ name: CORE_EXTENSION, tools, sections: [section("preamble", () => SYSTEM_PROMPT, { tag: false })] });
		const subagentExtension = defineExtension({
			name: SUBAGENT_EXTENSION,
			tools: [defineTool({
				name: "delegate",
				description: "Launch a durable subagent for a focused task and return its answer.",
				parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 8_000 }) }),
				replay: "safe",
				execute: async ({ task }, api, context) => {
					const childId = await api.commit(async (tx) => {
						const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
						if (existing) return existing.id;
						const created = await tx.createConversation({
							ownership: { kind: "task", taskId: api.taskId },
						});
						await configure(tx, created.id, { extensions: [coreExtension] });
						return created.id;
					}, context);
					await api.details({ conversationId: childId }, context);
					const child = await api.conversation(childId, context);
					if (!child) throw new Error("Pi Durable child conversation was not created");
					const settled = await (await child.submit({ type: "input", content: task, requestId: `delegate:${api.taskId}` }, context)).wait(context);
					if (settled.status !== "done") throw new Error(`Subagent failed: ${settled.reason}`);
					const entry = settled.type === "input" ? await api.commit((tx) => tx.entry(settled.answer), context) : undefined;
					return { content: [{ type: "text", text: assistantEntryText(entry) }] };
				},
			})],
		});
		this.registry.install(coreExtension);
		this.registry.install(subagentExtension);
		return Harness.open(storage, { models, registry: this.registry }, context);
	}

	private async runInContainer(command: string): Promise<string> {
		let commandError: unknown;
		let result: string | undefined;
		try {
			const container = this.ctx.container;
			if (!container) throw new Error("No Container is bound to PiAgent");
			if (!container.running) {
				const snapshot = await this.ctx.storage.get<ContainerSnapshot>("sandbox:snapshot");
				container.start(snapshot
					? { containerSnapshot: snapshot, instance: "standard-2", enableInternet: true }
					: { image: "cloudflare/debian-trixie", entrypoint: ["/bin/sleep", "infinity"], instance: "standard-2", enableInternet: true });
				this.ctx.waitUntil(container.monitor().catch((error: unknown) => {
					console.error(JSON.stringify({ event: "sandbox.monitor.failed", agentId: this.ctx.id.toString(), error: error instanceof Error ? error.message : String(error) }));
				}));
			}
			const process = await container.exec(["bash", "-lc", command]);
			const output = await process.output();
			result = JSON.stringify({
				exitCode: output.exitCode,
				stdout: new TextDecoder().decode(output.stdout).slice(0, 16_000),
				stderr: new TextDecoder().decode(output.stderr).slice(0, 8_000),
			});
		} catch (error) {
			commandError = error;
		}
		try {
			await this.saveSandbox();
		} catch (snapshotError) {
			if (commandError === undefined) throw snapshotError;
			console.error(JSON.stringify({ event: "sandbox.snapshot.failed", agentId: this.ctx.id.toString(), error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError) }));
		}
		if (commandError !== undefined) throw commandError;
		return result ?? "";
	}

	private async saveSandbox(): Promise<void> {
		const container = this.ctx.container;
		if (!container?.running) return;
		const snapshot = await container.snapshotContainer({ name: `agent-${this.ctx.id.toString()}` });
		await this.ctx.storage.put("sandbox:snapshot", snapshot);
		await container.destroy("Agent run paused");
	}

	async getStatus(): Promise<AgentStatus> {
		const status = (await this.ctx.storage.get<AgentStatus>("agent:status")) ?? {
			agentId: this.name, status: "idle", updatedAt: new Date(0).toISOString(),
		};
		if (status.status !== "running" || !status.operationId) return status;
		const pending = await this.piHarness.pending();
		if (pending.some((operation) => operation.operationId === status.operationId)) return status;
		const result = await this.piHarness.wait(status.operationId);
		if (result.status === "done") {
			await this.saveStatus({ status: "complete", lastResponse: result.text ?? "" });
		} else {
			await this.saveStatus({ status: "failed", lastError: result.reason ?? "Pi Durable conversation did not complete" });
		}
		return (await this.ctx.storage.get<AgentStatus>("agent:status")) ?? status;
	}

	async getEvents(): Promise<AgentEvent[]> {
		return (await this.ctx.storage.get<AgentEvent[]>("agent:events")) ?? [];
	}

	async inspectBrainAndHands(): Promise<AgentInspection> {
		const session = this.piHarness.session();
		const eventStream = await session.events();
		const snapshot = eventStream.snapshot;
		await eventStream.stop();
		const [entries, pending, sessions] = await Promise.all([
			session.messages(),
			this.piHarness.pending(),
			this.piHarness.sessions.list(),
		]);
		const registry = this.registry.snapshot();
		const extensionChoice = snapshot.agent.extensions;
		const defaultExtensions = registry.installed().map((extension) => extension.name);
		const selectedExtensions = new Set(Array.isArray(extensionChoice)
			? extensionChoice
			: [...defaultExtensions, ...(extensionChoice?.add ?? [])].filter((name) => !extensionChoice?.remove?.includes(name)));
		const toolChoice = snapshot.agent.tools;
		const defaultTools = registry.tools().filter(({ extension }) => selectedExtensions.has(extension.name)).map(({ tool }) => tool.name);
		const selectedTools = new Set(Array.isArray(toolChoice)
			? toolChoice
			: defaultTools.filter((name) => !toolChoice?.remove?.includes(name)));
		const tools = registry.tools().map(({ extension, tool }) => ({
			extension: extension.name,
			name: tool.name,
			replay: tool.replay ?? "unsafe (default)",
			executionMode: tool.executionMode ?? "configured default",
				selected: selectedExtensions.has(extension.name) && selectedTools.has(tool.name),
		}));
		return {
			brain: {
				model: snapshot.agent.model ? { provider: snapshot.agent.model.provider, modelId: snapshot.agent.model.modelId } : null,
				thinkingLevel: snapshot.agent.thinkingLevel ?? null,
				extensions: [...selectedExtensions],
				instructions: SYSTEM_PROMPT,
				usage: snapshot.usage,
				sessions,
				pending,
				transcript: entries.slice(-30).map((entry) => ({
					id: String(entry.id),
					kind: entry.kind,
					messages: (entry.model ?? []).map(inspectMessage),
				})),
				live: {
					generation: snapshot.generation ? {
						attempt: snapshot.generation.attempt,
						...(snapshot.generation.retry ? { retry: snapshot.generation.retry } : {}),
						...(snapshot.generation.deferred ? { deferred: snapshot.generation.deferred } : {}),
					} : null,
					inbox: snapshot.inbox,
				},
			},
			hands: {
				loadedTools: tools,
				nestedTools: this.nestedToolGroups,
				currentCalls: (snapshot.tools ?? []).map((slot) => ({
					name: slot.name,
					status: slot.status,
					...(slot.output ? { output: slot.output.slice(-2_000) } : {}),
					...(slot.diagnostics?.length ? { diagnostics: slot.diagnostics } : {}),
				})),
			},
		};
	}

	async interruptDemoRun(cause: DemoInterrupt): Promise<{ interrupted: boolean; operationId?: string }> {
		const status = await this.getStatus();
		if (status.status !== "running" || !status.operationId) return { interrupted: false };
		const details: Record<string, string | number | boolean> = cause === "deadline"
			? { source: "demo deadline control", action: "PiHarness.abort" }
			: { source: "demo fault injection", action: "PiHarness.abort", simulation: "resource limit only; no real Worker OOM" };
		await this.recordEvent(cause === "deadline" ? "demo.deadline.fired" : "demo.resource_limit.injected", details, "warn", status.operationId);
		const interrupted = await this.piHarness.abort({ operationId: status.operationId });
		return { interrupted, operationId: status.operationId };
	}

	async armDemoDeadline(seconds: number): Promise<{ scheduled: boolean; operationId?: string; deadlineAt?: string }> {
		const status = await this.getStatus();
		if (status.status !== "running" || !status.operationId) return { scheduled: false };
		const storageKey = `demo:deadline:${status.operationId}`;
		const previousDeadline = await this.ctx.storage.get<string>(storageKey);
		if (previousDeadline) await this.cancelSchedule(previousDeadline);
		const deadlineAt = new Date(Date.now() + seconds * 1_000);
		const schedule = await this.schedule(deadlineAt, "expireDemoDeadline", { operationId: status.operationId }, { idempotent: false });
		await this.ctx.storage.put(storageKey, schedule.id);
		await this.recordEvent("demo.deadline.armed", { seconds, deadlineAt: deadlineAt.toISOString() }, "info", status.operationId);
		return { scheduled: true, operationId: status.operationId, deadlineAt: deadlineAt.toISOString() };
	}

	async expireDemoDeadline(payload: { operationId: string }): Promise<void> {
		await this.ctx.storage.delete(`demo:deadline:${payload.operationId}`);
		const status = await this.ctx.storage.get<AgentStatus>("agent:status");
		if (status?.status !== "running" || status.operationId !== payload.operationId) {
			await this.recordEvent("demo.deadline.expired_after_completion", {}, "info", payload.operationId);
			return;
		}
		const interrupted = await this.piHarness.abort({ operationId: payload.operationId });
		await this.recordEvent("demo.deadline.fired", { source: "durable Agent schedule", interrupted }, "warn", payload.operationId);
	}

	private async saveStatus(update: Partial<AgentStatus> & Pick<AgentStatus, "status">): Promise<void> {
		const previous = await this.ctx.storage.get<AgentStatus>("agent:status");
		const status: AgentStatus = {
			agentId: this.name, status: update.status,
			updatedAt: new Date().toISOString(),
			...(update.lastError !== undefined ? { lastError: update.lastError } : {}),
			...(update.lastResponse !== undefined ? { lastResponse: update.lastResponse } : {}),
			...((update.operationId ?? previous?.operationId) ? { operationId: update.operationId ?? previous?.operationId } : {}),
		};
		if (update.status === "running") status.lastResponse = previous?.lastResponse;
		await this.ctx.storage.put("agent:status", status);
		if ((status.status === "complete" || status.status === "failed") && status.operationId) {
			const deadlineId = await this.ctx.storage.get<string>(`demo:deadline:${status.operationId}`);
			if (deadlineId && await this.cancelSchedule(deadlineId)) await this.ctx.storage.delete(`demo:deadline:${status.operationId}`);
		}
		await this.recordEvent(`agent.status.${status.status}`, {
			...(status.lastError ? { message: status.lastError } : {}),
		}, status.status === "failed" ? "error" : "info", status.operationId);
	}

	private async recordEvent(
		type: string,
		details: Record<string, string | number | boolean>,
		level: AgentEvent["level"] = "info",
		operationId?: string,
	): Promise<void> {
		const event: AgentEvent = {
			id: crypto.randomUUID(), at: new Date().toISOString(), type, level,
			...(operationId ? { operationId } : {}),
			...(Object.keys(details).length ? { details } : {}),
		};
		const events = [...await this.getEvents(), event].slice(-300);
		await this.ctx.storage.put("agent:events", events);
		console.log(JSON.stringify({ event: type, agentId: this.name, ...event }));
		this.broadcast(JSON.stringify(event));
	}
}

function assistantEntryText(entry: EntryRecord | undefined): string {
	const message = entry?.model?.[0];
	if (message?.role !== "assistant") return "";
	return message.content.map((part) => part.type === "text" ? part.text : "").join("");
}

function inspectMessage(message: EntryRecord["model"] extends readonly (infer Message)[] | undefined ? Message : never) {
	const value = message as unknown as { role?: string; content?: unknown[] };
	const parts = value.content ?? [];
	const content = parts.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		const record = part as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") return [record.text];
		if (record.type === "toolCall" && typeof record.name === "string") {
			return [`Tool call: ${record.name}${record.arguments === undefined ? "" : ` ${JSON.stringify(record.arguments)}`}`];
		}
		if (record.type === "toolResult") return ["Tool result"];
		return [];
	}).join("\n").slice(0, 2_000);
	return { role: value.role ?? "unknown", content };
}

function describeToolSet(group: string, tools: object): AgentInspection["hands"]["nestedTools"] {
	return Object.entries(tools as Record<string, { description?: unknown }>).map(([name, definition]) => {
		const description = typeof definition.description === "string"
			? definition.description
			: definition.description === undefined ? "No description provided." : "Description depends on runtime context.";
		return { group, name, description };
	});
}

function parseMcpServers(value: string | undefined): Array<{ name: string; url: string; headers?: Record<string, string> }> {
	if (!value) return [];
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed)) throw new Error("MCP_SERVERS_JSON must be a JSON array");
	return parsed.map((entry, index) => {
		if (!entry || typeof entry !== "object") throw new Error(`MCP server ${index} must be an object`);
		const server = entry as Record<string, unknown>;
		if (typeof server.name !== "string" || !server.name || typeof server.url !== "string" || !server.url) {
			throw new Error(`MCP server ${index} requires a name and URL`);
		}
		if (server.headers !== undefined && (!server.headers || typeof server.headers !== "object" || Array.isArray(server.headers) || Object.values(server.headers).some((header) => typeof header !== "string"))) {
			throw new Error(`MCP server ${index} headers must be string values`);
		}
		return { name: server.name, url: server.url, ...(server.headers ? { headers: server.headers as Record<string, string> } : {}) };
	});
}

function toPiTools(toolSet: Record<string, unknown>): ToolRegistration[] {
	return Object.entries(toolSet).flatMap(([name, raw]) => {
		if (!raw || typeof raw !== "object") return [];
		const tool = raw as AiTool;
		if (!tool.inputSchema || typeof tool.execute !== "function") return [];
		const parameters = Type.Unsafe<Record<string, unknown>>(z.toJSONSchema(tool.inputSchema));
		return [{
			name,
			description: tool.description ?? name,
			parameters,
			execute: async (args, _api) => {
				const result = await traceTool(name, () => tool.execute!(args as Record<string, unknown>, { toolCallId: crypto.randomUUID(), messages: [] }));
				return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
			},
		}];
	});
}

function traceTool<T>(name: string, run: () => Promise<T>): Promise<T> {
	return withCloudflareSpan(`agent.tool.${name}`, { "agent.tool.name": name }, async () => {
		const startedAt = Date.now();
		try {
			const result = await Effect.runPromise(Effect.tryPromise({
				try: run,
				catch: (cause) => new Error(`Tool ${name} failed`, { cause }),
			}).pipe(Effect.withSpan(`agent.tool.${name}`), withObservability));
			console.log(JSON.stringify({ event: "agent.tool", name, outcome: "ok", durationMs: Date.now() - startedAt }));
			return result;
		} catch (error) {
			console.error(JSON.stringify({ event: "agent.tool", name, outcome: "error", durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }));
			throw error;
		}
	});
}
