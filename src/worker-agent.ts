import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createAITools } from "@cloudflare/computer/tools";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { configure, createRegistry, defineExtension, defineTool, Harness, section, type EntryRecord, type SnapshotEvent, type ToolRegistration } from "@earendil-works/pi-durable";
import { Agent as DurableAgent, type AgentContext, type Connection } from "agents";
import { PiHarness, type PiHarnessContext } from "agents/harness/pi";
import { createBrowserRuntime } from "agents/browser/ai";
import { createAI } from "agents/models/pi-ai";
import { tool } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import { withCloudflareSpan, withObservability } from "./observability";
import type { AgentEvent, AgentInspection, AgentStatus, DemoInterrupt, Env } from "./types";

const DEFAULT_MODEL = "@cf/zai-org/glm-5.3-flash";
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
	private browserRuntime?: ReturnType<typeof createBrowserRuntime>;
	private trajectoryStreams = new Map<string, { stop: () => Promise<unknown> }>();
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
		const previousBootId = await this.ctx.storage.get<string>("agent:boot-id");
		await this.ctx.storage.put("agent:boot-id", crypto.randomUUID());
		const status = await this.ctx.storage.get<AgentStatus>("agent:status");
		if (!status) {
			await this.saveStatus({ status: "idle" });
			return;
		}
		if (previousBootId && status.status === "running" && status.operationId) {
			const pending = await this.piHarness.pending();
			if (pending.some((operation) => operation.operationId === status.operationId)) {
				await this.recordEvent("agent.runtime.recovered", {
					previousBootId,
					bootId: await this.ctx.storage.get<string>("agent:boot-id") ?? "unknown",
					mechanism: "Pi Durable restored persisted session tasks",
				}, "info", status.operationId);
			}
		}
	}

	async onConnect(connection: Connection): Promise<void> {
		for (const event of await this.getEvents()) connection.send(JSON.stringify(event));
		await this.recordEvent("client.connected", { connectionId: connection.id });
		const stream = await this.piHarness.session().events();
		const snapshot = compactTrajectorySnapshot(stream.snapshot);
		connection.send(JSON.stringify({ type: "pi.trajectory", events: [snapshot] }));
		stream.start(async (events) => {
			try {
				connection.send(JSON.stringify({ type: "pi.trajectory", events: events.map((event) => event.type === "snapshot" ? compactTrajectorySnapshot(event) : event) }));
			} catch (error) {
				await this.recordEvent("agent.trajectory.stream.error", {
					message: error instanceof Error ? error.message : String(error),
				}, "warn");
			}
		});
		this.trajectoryStreams.set(connection.id, { stop: () => stream.stop() });
	}

	async onMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
		if (message === "ping") connection.send("pong");
	}

	async onClose(connection: Connection, code: number, reason: string, wasClean: boolean): Promise<void> {
		const stream = this.trajectoryStreams.get(connection.id);
		this.trajectoryStreams.delete(connection.id);
		if (stream) await stream.stop();
		await this.recordEvent("client.disconnected", {
			connectionId: connection.id,
			code,
			reason: reason.slice(0, 120),
			wasClean,
		}, wasClean ? "info" : "warn");
	}

	async onError(connectionOrError: Connection | unknown, error?: unknown): Promise<void> {
		if (typeof connectionOrError === "object" && connectionOrError !== null && "id" in connectionOrError) {
			const connection = connectionOrError as Connection;
			const stream = this.trajectoryStreams.get(connection.id);
			this.trajectoryStreams.delete(connection.id);
			if (stream) await stream.stop();
		}
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
		this.browserRuntime = createBrowserRuntime({ ctx: this.ctx, browser: this.env.BROWSER, loader: this.env.LOADER, session: { mode: "dynamic" } });
		const browserTools = this.browserRuntime.tools;
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
		const directWorkspace = createPiTools({ workspace: this.workspace, readonly: true });
		const tools: ToolRegistration[] = [
			...toPiWorkspaceTools(directWorkspace),
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

	async getRuntimeBootId(): Promise<string | undefined> {
		return this.ctx.storage.get<string>("agent:boot-id");
	}

	async resumeDemoRun(): Promise<{ resumed: boolean; operationId?: string; status: AgentStatus["status"]; bootId?: string }> {
		const status = await this.getStatus();
		if (status.status !== "running" || !status.operationId) {
			await this.recordEvent("agent.runtime.nothing_to_resume", { status: status.status }, "info", status.operationId);
			return { resumed: false, status: status.status, ...(status.operationId ? { operationId: status.operationId } : {}), bootId: await this.getRuntimeBootId() };
		}
		const pending = await this.piHarness.pending();
		if (!pending.some((operation) => operation.operationId === status.operationId)) {
			const settled = await this.getStatus();
			await this.recordEvent("agent.runtime.nothing_to_resume", { status: settled.status }, "info", status.operationId);
			return { resumed: false, status: settled.status, operationId: status.operationId, bootId: await this.getRuntimeBootId() };
		}
		await this.recordEvent("agent.runtime.resume_requested", {
			mechanism: "Pi Durable pending operation; prompt was not resubmitted",
		}, "info", status.operationId);
		return { resumed: true, status: "running", operationId: status.operationId, bootId: await this.getRuntimeBootId() };
	}

	async inspectBrainAndHands(): Promise<AgentInspection> {
		const session = this.piHarness.session();
		const eventStream = await session.events();
		const snapshot = eventStream.snapshot;
		await eventStream.stop();
		const pi = await this.piHarness.pi();
		const taskGraph = await pi.taskGraph(BACKGROUND_CONTEXT);
		const tasks = Object.values(taskGraph.value.tasks).map(({ id, kind, conversationId, owner, state, background, abortRequested }) => ({
			id: String(id),
			kind,
			conversationId: String(conversationId),
			...(owner ? { owner: String(owner) } : {}),
			status: state.status,
			phase: "phase" in state ? state.phase : state.outcome,
			background,
			abortRequested,
		}));
		taskGraph.dispose();
		const inspectionErrors: string[] = [];
		const [entries, pending, sessions, workspaceFiles, artifactRepos, browserExecutions, browserSession] = await Promise.all([
			session.messages(),
			this.piHarness.pending(),
			this.piHarness.sessions.list(),
			this.workspace.fs.find("/", undefined, { limit: 100 }),
			this.workspace.artifacts.list().catch((error: unknown) => { inspectionErrors.push(`Artifacts: ${errorMessage(error)}`); return []; }),
			(this.browserRuntime?.runtime.executions(10) ?? Promise.resolve([])).catch((error: unknown) => { inspectionErrors.push(`Browser executions: ${errorMessage(error)}`); return []; }),
			(this.browserRuntime?.connector.sessionInfo() ?? Promise.resolve(undefined)).catch((error: unknown) => { inspectionErrors.push(`Browser session: ${errorMessage(error)}`); return undefined; }),
		]);
		const sandboxSnapshot = await this.ctx.storage.get<ContainerSnapshot>("sandbox:snapshot");
		const snapshotMetadata = sandboxSnapshot as unknown as { name?: unknown; size?: unknown } | undefined;
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
				tasks,
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
					compactions: snapshot.compactions,
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
				recentTools: inspectRecentTools(entries),
				workspaceFiles,
				artifactRepos: artifactRepos.map(({ name, description }) => ({ name, ...(description ? { description } : {}) })),
				mcpServers: this.mcp.listServers().map(({ id, name, server_url }) => ({ id, name, endpoint: safeMcpEndpoint(server_url) })),
				inspectionErrors,
				browser: {
					executions: browserExecutions.map(({ id, status, code, error }) => ({ id, status, code: code.slice(0, 1_200), ...(error ? { error } : {}) })),
					session: browserSession ? {
						sessionId: browserSession.sessionId,
						targets: (browserSession.targets ?? []).slice(0, 10).map(({ id, type, url, title }) => ({ id, ...(type ? { type } : {}), ...(url ? { url } : {}), ...(title ? { title } : {}) })),
					} : null,
				},
				sandbox: {
					containerRunning: Boolean(this.ctx.container?.running),
					snapshotAvailable: Boolean(sandboxSnapshot),
					...(typeof snapshotMetadata?.name === "string" ? { snapshotName: snapshotMetadata.name } : {}),
					...(typeof snapshotMetadata?.size === "number" ? { snapshotSize: snapshotMetadata.size } : {}),
				},
			},
		};
	}

	async interruptDemoRun(cause: DemoInterrupt): Promise<{ interrupted: boolean; operationId?: string }> {
		const status = await this.getStatus();
		if (status.status !== "running" || !status.operationId) return { interrupted: false };
		const details: Record<string, string | number | boolean> = cause === "deadline"
			? { source: "demo deadline control", action: "PiHarness.abort" }
			: { source: "demo fault injection", action: "Durable Object context abort", simulation: "abrupt object restart; no real Worker OOM" };
		await this.recordEvent(cause === "deadline" ? "demo.deadline.fired" : "demo.runtime.restart_requested", details, "warn", status.operationId);
		if (cause === "runtime-crash") {
			this.ctx.abort("Demo: simulate abrupt Durable Object restart", { retryAlarm: true });
			return { interrupted: true, operationId: status.operationId };
		}
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
	const value = message as unknown as { role?: string; content?: unknown };
	const rawContent = value.content;
	const parts = Array.isArray(rawContent)
		? rawContent
		: typeof rawContent === "string"
			? [{ type: "text", text: rawContent }]
			: rawContent && typeof rawContent === "object"
				? ("type" in rawContent ? [rawContent] : Object.values(rawContent))
				: [];
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

function compactTrajectorySnapshot(snapshot: SnapshotEvent) {
	return {
		type: "snapshot" as const,
		generation: snapshot.generation,
		history: snapshot.entries.slice(-30).map((entry) => ({
			id: String(entry.id),
			kind: entry.kind,
			messages: (entry.model ?? []).map(inspectMessage),
		})),
		tools: snapshot.tools.map(({ name, status, output }) => ({ name, status, ...(output ? { output: output.slice(-1_000) } : {}) })),
		compactions: snapshot.compactions.slice(-5),
		inbox: snapshot.inbox.slice(-10),
		usage: snapshot.usage,
	};
}

function inspectRecentTools(entries: readonly EntryRecord[]): AgentInspection["hands"]["recentTools"] {
	const results = new Map<string, { result?: string; isError?: boolean }>();
	const calls: Array<{ id?: string; item: AgentInspection["hands"]["recentTools"][number] }> = [];
	for (const entry of entries) {
		for (const message of entry.model ?? []) {
			const value = message as unknown as { role?: string; toolCallId?: string; content?: unknown; isError?: boolean };
			const parts = Array.isArray(value.content) ? value.content : [];
			if (value.role === "tool" && typeof value.toolCallId === "string") {
				const result = parts.flatMap((block) => block && typeof block === "object" && "text" in block && typeof block.text === "string" ? [block.text] : []).join("\n");
				results.set(value.toolCallId, { result: result.slice(0, 1_000), isError: value.isError === true });
			}
			for (const item of parts) {
				if (!item || typeof item !== "object") continue;
				const part = item as Record<string, unknown>;
				if (part.type === "toolCall" && typeof part.name === "string") {
					calls.push({
						id: typeof part.id === "string" ? part.id : undefined,
						item: { name: part.name, ...(part.arguments === undefined ? {} : { arguments: JSON.stringify(part.arguments).slice(0, 800) }) },
					});
				}
			}
		}
	}
	return calls.slice(-12).map(({ id, item }) => ({ ...item, ...(id && results.has(id) ? results.get(id) : {}) }));
}

function toPiWorkspaceTools(computer: ReturnType<typeof createPiTools>): ToolRegistration[] {
	return computer.tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters),
		replay: "safe",
		execute: async (args) => {
			const result = await traceTool(tool.name, () => computer.execute({ id: crypto.randomUUID(), name: tool.name, arguments: args }));
			return { content: result.content, isError: result.isError };
		},
	}));
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

function safeMcpEndpoint(value: string): string {
	try {
		const endpoint = new URL(value);
		return endpoint.origin;
	} catch {
		return "configured endpoint";
	}
}

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 240);
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
