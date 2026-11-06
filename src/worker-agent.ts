import { Workspace } from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createGitClient } from "@cloudflare/computer/git";
import { createCloudflareObserver } from "@cloudflare/computer/observe/cloudflare";
import { createPiTools, type CreatePiToolsResult } from "@cloudflare/computer/tools/pi-ai";
import { CodemodeConnector, createCodemodeRuntime, DynamicWorkerExecutor, McpConnector, sanitizeToolName, type ConnectorTools, type McpConnectionLike } from "@cloudflare/codemode";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry,
	configure,
	defineExtension,
	defineTool,
	Harness,
	section,
	createRegistry,
	type AgentState,
	type ConversationView,
	type ConversationWatch,
	type EntryRecord,
	type Extension,
	type LiveState,
	type Report,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { Agent, type AgentContext, type Connection, type ConnectionContext } from "agents";
import { Browser, browserRun } from "agents/browser";
import { browserTool } from "agents/browser/pi";
import { PiHarness, type PiHarnessContext } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";
import { fetchWeb, type WebFetchRequest } from "agents/webfetch";
import { webFetchTool } from "agents/webfetch/pi";
import { createAIWebSearch, MAX_WEB_SEARCH_LIMIT, type WebSearchToolInput } from "agents/websearch";
import { webSearchTool } from "agents/websearch/pi";
import { tracing } from "cloudflare:workers";
import { errorMessage, traced } from "./observability";
import { decodeMcpServers } from "./schemas";
import type { AgentEvent, AgentInspection, AgentStatus, ConversationSnapshot, DemoInterrupt, Env, ToolCallView, TranscriptItem } from "./types";

const DEFAULT_MODEL = "@cf/zai-org/glm-5.3-flash";
const CORE_EXTENSION = "cloudflare-agent-tools";
const SUBAGENT_EXTENSION = "durable-subagents";
const SYSTEM_PROMPT = `You are an agent running on Pi Durable. Your conversation and work are saved, so a restart resumes where you stopped.

Tools:
- Workspace files that persist between runs: read, write, edit, delete, ls, find, grep, and exec (a shell with git and Artifacts commands).
- container_exec: a Linux container whose files are saved between commands. It is separate from the workspace.
- web_search, web_fetch, and browser.
- code_mode: one script that calls workspace.*, web.*, and MCP server methods. Inside it, codemode.search() and codemode.describe() list what is available.

Save facts that will help later runs in /memory.md. Check each step before the next, and say what you did and what failed.`;
/** Computer tools that are safe to run again if a restart interrupts them (same list as the Agents Pi harness example). */
const REPLAY_SAFE_WORKSPACE_TOOLS = new Set(["read", "ls", "find", "grep", "write", "delete"]);
const MAX_EVENTS = 300;
/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const SOCKET_OPEN = 1;

const Delegate = obj({ task: str({ minLength: 1, maxLength: 8_000, description: "A self-contained task for the subagent." }) });
const GenerateImage = obj({
	modelId: str({ minLength: 1, maxLength: 200, description: "Workers AI image model id, such as @cf/black-forest-labs/flux-1-schnell." }),
	prompt: str({ minLength: 1, maxLength: 4_000 }),
});
const ContainerExec = obj({ command: str({ minLength: 1, maxLength: 16_384 }) });
const CodeMode = obj({ code: str({ minLength: 1, description: "An async arrow function. Connector methods are globals (workspace.*, web.*, and one per MCP server); codemode.search() and codemode.describe() find them." }) });

/** Reads Code Mode runs again when a script resumes, instead of storing their results. */
const WORKSPACE_READS = new Set(["read", "ls", "find", "grep"]);

/**
 * Computer's workspace tools for Code Mode scripts, run by the same `createPiTools`
 * executor as the tools Pi calls directly. A script gets each tool's structured result;
 * a failed call throws in the script with the tool's message.
 */
class WorkspaceConnector extends CodemodeConnector {
	constructor(ctx: DurableObjectState, private readonly computer: CreatePiToolsResult) {
		super(ctx as unknown as ExecutionContext, {});
	}

	name(): string {
		return "workspace";
	}

	protected instructions(): string {
		return "Files in the agent's durable workspace, and exec in its shell (git and Artifacts commands included).";
	}

	protected tools(): ConnectorTools {
		return Object.fromEntries(this.computer.tools.map((tool) => [tool.name, {
			description: tool.description,
			inputSchema: tool.parameters as ConnectorTools[string]["inputSchema"],
			...(WORKSPACE_READS.has(tool.name) ? { replay: "reexecute" as const } : {}),
			execute: async (args: unknown) => {
				const result = await this.computer.execute({ id: crypto.randomUUID(), name: tool.name, arguments: args });
				const text = result.content.map((part) => part.type === "text" ? part.text : `[${part.mimeType} image]`).join("\n");
				if (result.isError) throw new Error(text);
				return result.details ?? text;
			},
		}]));
	}
}

/**
 * Web search and fetch for Code Mode scripts, using the functions Agents provides for
 * calling them without a model (`createAIWebSearch`, `fetchWeb`). A script gets the full
 * search response and the whole page; the model sees only what the script returns.
 */
class WebConnector extends CodemodeConnector {
	constructor(ctx: DurableObjectState, private readonly ai: Ai, private readonly gateway: string) {
		super(ctx as unknown as ExecutionContext, {});
	}

	name(): string {
		return "web";
	}

	protected instructions(): string {
		return "Search the live web, then read result URLs with fetch.";
	}

	protected tools(): ConnectorTools {
		const search = createAIWebSearch({ binding: this.ai, gateway: this.gateway });
		return {
			search: {
				description: "Search the live web. Resolves with { items: [{ url, title, description }], metadata }.",
				inputSchema: {
					type: "object",
					properties: { query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: MAX_WEB_SEARCH_LIMIT } },
					required: ["query"],
					additionalProperties: false,
				},
				execute: (args) => search.search(args as WebSearchToolInput),
			},
			fetch: {
				description: "Read one http(s) URL. Resolves with the page: Markdown for HTML, PDFs, and documents (format \"auto\"), or the body as served (\"raw\"), with title, status, and content.",
				inputSchema: {
					type: "object",
					properties: { url: { type: "string", minLength: 1 }, format: { type: "string", enum: ["auto", "raw"] } },
					required: ["url"],
					additionalProperties: false,
				},
				execute: (args) => fetchWeb(args as WebFetchRequest, { binding: this.ai }),
			},
		};
	}
}

/** One configured MCP server for Code Mode scripts, using the agent's open MCP connection. */
class AgentMcpConnector extends McpConnector {
	constructor(ctx: DurableObjectState, private readonly connectorName: string, private readonly connection: McpConnectionLike) {
		super(ctx as unknown as ExecutionContext, {});
	}

	name(): string {
		return this.connectorName;
	}

	protected instructions(): string | undefined {
		return this.connection.instructions;
	}

	protected createConnection(): McpConnectionLike {
		return this.connection;
	}
}

export class PiAgent extends Agent<Env> {
	/** One Pi conversation watch per socket. They live in memory, so `onStart` starts them again after hibernation. */
	private readonly viewWatches = new Map<string, ConversationWatch>();
	readonly ai = createAI({ binding: this.env.AI });
	/** One registry per object, not per module: a Harness stays subscribed to its registry until it closes. */
	readonly registry = createRegistry();
	readonly browser = new Browser({ provider: browserRun(this.env.BROWSER) });
	readonly workspace = new Workspace({
		storage: this.ctx.storage,
		artifacts: { binding: this.env.ARTIFACTS, sessionId: this.ctx.id.toString() },
		git: createGitClient(),
		defaultGitIdentity: { name: "Pi Agent", email: "pi-agent@invalid.local" },
		observer: createCloudflareObserver({ tracing }),
		backends: [
			new WorkerShellBackend({
				id: "shell",
				loader: this.env.LOADER,
				workspace: { binding: "PI_AGENT", id: this.ctx.id.toString() },
				ctx: this.ctx,
			}),
		],
	});
	readonly piHarness = new PiHarness({
		harness: (context) => this.openPi(context),
		defaults: { model: this.ai(this.env.MODEL_ID ?? DEFAULT_MODEL) },
	});

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.lifecycle.use(this.browser).use(this.piHarness);
	}

	/**
	 * The worker shell runs in a Dynamic Worker and reaches this Workspace through the
	 * exported `WorkspaceServiceProxy`, which calls this method. `withWorkspace` would add
	 * it; this class creates its Workspace directly, so it defines the method itself.
	 */
	async __getWorkspaceStub() {
		await this.workspace.ready();
		return this.workspace.stub();
	}

	/** Runs on every start, after Browser and PiHarness have started, so Pi is already open. */
	async onStart(): Promise<void> {
		this.sql`CREATE TABLE IF NOT EXISTS agent_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL)`;
		await this.connectMcpServers();
		const previousBootId = await this.ctx.storage.get<string>("agent:boot-id");
		const bootId = crypto.randomUUID();
		await this.ctx.storage.put("agent:boot-id", bootId);
		const status = await this.ctx.storage.get<AgentStatus>("agent:status");
		if (!status) {
			await this.saveStatus({ status: "idle" });
		} else if (status.status === "running" && status.operationId) {
			const pending = await this.piHarness.pending();
			if (previousBootId && pending.some((operation) => operation.operationId === status.operationId)) {
				await this.recordEvent("agent.runtime.recovered", {
					previousBootId,
					bootId,
					mechanism: "PiHarness reopened Pi, which resumed its saved tasks",
				}, "info", status.operationId);
			}
			// Not awaited: startup must not wait for the run to finish.
			void this.settleWhenDone(status.operationId);
		}
		// Sockets stay open while the object hibernates; give each one a new watch.
		for (const connection of this.getConnections()) await this.watchView(connection);
	}

	/** The Event Lab has its own messages, so skip the Agents state and identity messages. */
	shouldSendProtocolMessages(_connection: Connection, _context: ConnectionContext): boolean {
		return false;
	}

	async onConnect(connection: Connection): Promise<void> {
		for (const event of await this.getEvents()) send(connection, event);
		await this.recordEvent("client.connected", { connectionId: connection.id });
		await this.watchView(connection);
	}

	async onMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
		if (message === "ping") connection.send("pong");
	}

	async onClose(connection: Connection, code: number, reason: string, wasClean: boolean): Promise<void> {
		await this.unwatchView(connection.id);
		await this.recordEvent("client.disconnected", {
			connectionId: connection.id,
			code,
			reason: reason.slice(0, 120),
			wasClean,
		}, wasClean ? "info" : "warn");
	}

	async onError(connectionOrError: Connection | unknown, error?: unknown): Promise<void> {
		if (typeof connectionOrError === "object" && connectionOrError !== null && "id" in connectionOrError) {
			await this.unwatchView((connectionOrError as Connection).id);
		}
		await this.recordEvent("agent.websocket.error", { message: errorMessage(error ?? connectionOrError) }, "error");
	}

	/**
	 * Starts a watch of the root conversation for a socket, replacing its old one, and
	 * sends the conversation state on every change. A watch also ends when Pi closes (as
	 * PiHarness does to reopen Pi after an error); the socket then gets a new watch. If
	 * Pi can't be watched, the socket is closed so the page reconnects.
	 */
	private async watchView(connection: Connection): Promise<void> {
		let watch: ConversationWatch;
		try {
			watch = await this.piHarness.session().watch();
		} catch (error) {
			console.warn(JSON.stringify({ event: "pi.view.watch_failed", agentId: this.name, error: errorMessage(error) }));
			try {
				connection.close(1011, "Lost the session's watch");
			} catch {
				// Already closed.
			}
			return;
		}
		if (connection.readyState !== SOCKET_OPEN) {
			await watch.stop();
			return;
		}
		const previous = this.viewWatches.get(connection.id);
		this.viewWatches.set(connection.id, watch);
		void previous?.stop();
		send(connection, { type: "pi.view", view: projectView(watch.value) });
		watch.start(async (call) => {
			// Pi ends a watch on failure instead of sending a `failed` call.
			if (call.kind !== "value") return;
			if (connection.readyState !== SOCKET_OPEN) {
				await this.unwatchView(connection.id);
				return;
			}
			send(connection, { type: "pi.view", view: projectView(call.value) });
		});
		void watch.closed.then((end) => {
			if (end.kind === "stopped" || end.kind === "aborted") return;
			if (this.viewWatches.get(connection.id) !== watch) return;
			this.viewWatches.delete(connection.id);
			if (connection.readyState === SOCKET_OPEN) return this.watchView(connection);
		});
	}

	private async unwatchView(connectionId: string): Promise<void> {
		const watch = this.viewWatches.get(connectionId);
		this.viewWatches.delete(connectionId);
		if (watch) await watch.stop();
	}

	async run(prompt: string): Promise<{ text: string }> {
		const operationId = crypto.randomUUID();
		try {
			return await traced("agent.run", { "agent.id": this.name, "agent.operation_id": operationId }, async () => {
				await this.saveStatus({ status: "running", operationId });
				const result = await this.piHarness.prompt(prompt, { operationId });
				if (result.status !== "done") throw new Error(unansweredMessage(result.reason));
				const text = result.text ?? "";
				await this.finishRun(operationId, { status: "complete", lastResponse: text });
				return { text };
			});
		} catch (error) {
			await this.finishRun(operationId, { status: "failed", lastError: errorMessage(error) });
			throw error;
		}
	}

	async launch(prompt: string): Promise<{ operationId: string }> {
		const operationId = crypto.randomUUID();
		return traced("agent.launch", { "agent.id": this.name, "agent.operation_id": operationId }, async () => {
			await this.saveStatus({ status: "running", operationId });
			try {
				await this.piHarness.submit(prompt, { operationId });
			} catch (error) {
				await this.saveStatus({ status: "failed", lastError: errorMessage(error) });
				throw error;
			}
			void this.settleWhenDone(operationId);
			return { operationId };
		});
	}

	/**
	 * Records a launched run's result when Pi finishes it, so the status changes even if
	 * nobody asks. If the object is evicted first, `onStart` calls this again.
	 */
	private async settleWhenDone(operationId: string): Promise<void> {
		try {
			const result = await this.piHarness.wait(operationId);
			await this.finishRun(operationId, result.status === "done"
				? { status: "complete", lastResponse: result.text ?? "" }
				: { status: "failed", lastError: unansweredMessage(result.reason) });
		} catch (error) {
			console.warn(JSON.stringify({ event: "agent.settle.failed", agentId: this.name, operationId, error: errorMessage(error) }));
		}
	}

	/**
	 * Opens Pi for PiHarness. It can run more than once (after a storage error), which is
	 * fine: installing an extension with the same name replaces the old one.
	 */
	private async openPi({ storage, context, onWake }: PiHarnessContext): Promise<Harness> {
		const models = createModels();
		models.setProvider(this.ai.provider);
		const core = this.coreExtension();
		const subagents: Extension = defineExtension({
			name: SUBAGENT_EXTENSION,
			tools: [defineTool({
				name: "delegate",
				description: "Launch a durable subagent for a focused task and return its answer.",
				parameters: Delegate,
				// If a restart reruns this call, it finds the same child conversation and prompt.
				replay: "safe",
				execute: async ({ task }, api, context) => {
					const childId = await api.commit(async (tx) => {
						const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
						if (existing !== undefined) return existing.id;
						// The child starts with this conversation's settings; it can't start subagents of its own.
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { extensions: { remove: [subagents] } });
						return created.id;
					}, context);
					// Lets a UI find the child conversation.
					await api.details({ conversationId: String(childId) }, context);
					const child = await api.conversation(childId, context);
					if (!child) throw new Error("Pi Durable child conversation was not created");
					const submission = await child.submit({ type: "input", content: task, requestId: `delegate:${api.taskId}` }, context);
					const settled = await submission.wait(context);
					if (settled.status !== "done" || settled.type !== "input") throw new Error(`Subagent ended unanswered: ${settled.status === "unanswered" ? settled.reason : "no answer"}`);
					const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
					return { output: [{ type: "text", text: assistantEntryText(entry) }] };
				},
			})],
		});
		this.registry.install(core);
		this.registry.install(subagents);
		return Harness.open(storage, { models, registry: this.registry, onWake, onReport: (report) => this.report(report) }, context);
	}

	/** Computer's workspace tools: one list of tools and one executor, used by both Pi and Code Mode. */
	private computerTools(): CreatePiToolsResult {
		return createPiTools({
			workspace: this.workspace,
			exec: { backends: { shell: { description: "Persistent workspace files, git, and Artifacts repositories." } } },
		});
	}

	/**
	 * Code Mode's runtime. Its call log lives in the `CodemodeRuntime` class the Worker
	 * exports; the connectors are built fresh for each call, as Code Mode's docs describe.
	 * MCP servers are added through the agent's open connections.
	 */
	private codemodeRuntime() {
		const mcp = this.mcp.listServers().flatMap((server) => {
			const connection = this.mcp.mcpConnections[server.id];
			return connection ? [new AgentMcpConnector(this.ctx, sanitizeToolName(server.name), connection)] : [];
		});
		return createCodemodeRuntime({
			ctx: this.ctx,
			executor: new DynamicWorkerExecutor({ loader: this.env.LOADER }),
			connectors: [
				new WorkspaceConnector(this.ctx, this.computerTools()),
				new WebConnector(this.ctx, this.env.AI, this.env.AI_GATEWAY_ID ?? "default"),
				...mcp,
			],
		});
	}

	private coreExtension(): Extension {
		const codeMode: ToolRegistration<typeof CodeMode> = {
			name: "code_mode",
			description: this.codemodeRuntime().tool().description,
			parameters: CodeMode,
			execute: async ({ code }) => {
				await this.mcp.waitForConnections({ timeout: 10_000 });
				const result = await traced("agent.tool.code_mode", { "agent.tool.name": "code_mode" }, () => this.codemodeRuntime().execute({ code }));
				// The model gets everything except the call log, as with Code Mode's own tool.
				const { calls: _calls, ...visible } = result;
				return {
					output: [{ type: "text", text: JSON.stringify(visible) }],
					isError: result.status === "error",
					details: { executionId: result.executionId, status: result.status },
				};
			},
		};
		const generateImage: ToolRegistration<typeof GenerateImage> = {
			name: "generate_image",
			description: "Generate an image with a Workers AI image model and return it in the conversation.",
			parameters: GenerateImage,
			execute: async ({ modelId, prompt }) => traced("agent.tool.generate_image", { "agent.tool.name": "generate_image" }, async () => {
				const result = await this.ai.generateImages(this.ai.images(modelId), { input: [{ type: "text", text: prompt }] });
				if (result.stopReason === "error") throw new Error(result.errorMessage ?? "Image generation failed");
				return { output: result.output, ...(result.usage ? { usage: result.usage } : {}) };
			}),
		};
		const containerExec: ToolRegistration<typeof ContainerExec> = {
			name: "container_exec",
			description: "Run a command in this agent's resumable Linux sandbox. Its filesystem is separate from the durable workspace.",
			parameters: ContainerExec,
			executionMode: "sequential",
			execute: async ({ command }) => ({
				output: [{ type: "text", text: await traced("agent.tool.container_exec", { "agent.tool.name": "container_exec" }, () => this.runInContainer(command)) }],
			}),
		};
		return defineExtension({
			name: CORE_EXTENSION,
			sections: [section("preamble", () => SYSTEM_PROMPT, { tag: false })],
			tools: [
				...this.workspaceTools(),
				webSearchTool({ binding: this.env.AI, gateway: this.env.AI_GATEWAY_ID ?? "default" }),
				webFetchTool({ binding: this.env.AI }),
				browserTool({ browser: this.browser, loader: this.env.LOADER }),
				codeMode,
				generateImage,
				containerExec,
			],
		});
	}

	/**
	 * Computer's workspace tools for Pi. `createPiTools` returns tool declarations and one
	 * `execute` function meant for a hand-written loop. Pi runs its own loop, so each tool
	 * gets its own `execute` (as in the Agents Pi harness example).
	 */
	private workspaceTools(): ToolRegistration[] {
		const { tools, execute } = this.computerTools();
		return tools.map((tool): ToolRegistration => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			...(tool.constrainedSampling ? { constrainedSampling: tool.constrainedSampling } : {}),
			replay: REPLAY_SAFE_WORKSPACE_TOOLS.has(tool.name) ? "safe" : "unsafe",
			execute: async (args, api, context) => {
				const { content, isError } = await traced(`agent.tool.${tool.name}`, { "agent.tool.name": tool.name }, () =>
					execute({ id: api.callId, name: tool.name, arguments: args }, { abortSignal: context.abortSignal }));
				return { output: content, isError };
			},
		}));
	}

	private report(report: Report): void {
		console.error(JSON.stringify({
			event: "pi.report",
			agentId: this.name,
			kind: report.kind,
			...("reason" in report && report.reason ? { reason: report.reason } : {}),
			...("task" in report && report.task ? { taskId: String(report.task.id), taskKind: report.task.kind } : {}),
			error: errorMessage(report.error),
		}));
	}

	/** Adding a server with the same name and URL does nothing, so this is safe on every start. */
	private async connectMcpServers(): Promise<void> {
		for (const server of parseMcpServers(this.env.MCP_SERVERS_JSON)) {
			await this.addMcpServer(server.name, server.url, server.headers ? { transport: { headers: server.headers } } : undefined);
		}
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
					console.error(JSON.stringify({ event: "sandbox.monitor.failed", agentId: this.name, error: errorMessage(error) }));
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
			console.error(JSON.stringify({ event: "sandbox.snapshot.failed", agentId: this.name, error: errorMessage(snapshotError) }));
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
		// Not pending means finished. The timeout covers a run Pi never accepted.
		const result = await this.piHarness.wait(status.operationId, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
		await this.finishRun(status.operationId, !result
			? { status: "failed", lastError: "Pi Durable has no record of this run" }
			: result.status === "done"
				? { status: "complete", lastResponse: result.text ?? "" }
				: { status: "failed", lastError: unansweredMessage(result.reason) });
		return (await this.ctx.storage.get<AgentStatus>("agent:status")) ?? status;
	}

	async getEvents(): Promise<AgentEvent[]> {
		return this.sql<{ event: string }>`SELECT event FROM agent_events ORDER BY seq`.map(({ event }) => JSON.parse(event) as AgentEvent);
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
		await this.recordEvent("agent.runtime.resume_requested", {
			mechanism: "Pi still has this run; the prompt was not sent again",
		}, "info", status.operationId);
		return { resumed: true, status: "running", operationId: status.operationId, bootId: await this.getRuntimeBootId() };
	}

	async inspectBrainAndHands(): Promise<AgentInspection> {
		const inspectionErrors: string[] = [];
		const pi = await this.piHarness.pi();
		const [viewWatch, taskGraphWatch] = await Promise.all([
			this.piHarness.session().watch({ min: 30 }),
			pi.watchTaskGraph(BACKGROUND_CONTEXT),
		]);
		const view = viewWatch.value;
		const taskGraph = taskGraphWatch.value;
		await Promise.all([viewWatch.stop(), taskGraphWatch.stop()]);
		const tasks = Object.values(taskGraph.tasks).map(({ id, kind, conversationId, owner, state, background, abortRequested }) => ({
			id: String(id),
			kind,
			conversationId: String(conversationId),
			...(owner ? { owner: String(owner) } : {}),
			status: state.status,
			background,
			abortRequested,
		}));
		const [pending, sessions, workspaceFiles, artifactRepos] = await Promise.all([
			this.piHarness.pending(),
			this.piHarness.sessions.list(),
			this.workspace.fs.find("/", undefined, { limit: 100 }),
			this.workspace.artifacts.list().catch((error: unknown) => {
				inspectionErrors.push(`Artifacts: ${errorMessage(error).slice(0, 240)}`);
				return [];
			}),
		]);
		const sandboxSnapshot = await this.ctx.storage.get<ContainerSnapshot>("sandbox:snapshot");
		const snapshotMetadata = sandboxSnapshot as unknown as { name?: unknown; size?: unknown } | undefined;
		const agent = (view.docs["pi.agent"] ?? {}) as AgentState;
		const live = (view.docs["pi.live"] ?? {}) as LiveState;
		const registry = this.registry.snapshot();
		const extensionChoice = agent.extensions;
		const defaultExtensions = registry.installed().map((extension) => extension.name);
		const selectedExtensions = new Set(Array.isArray(extensionChoice)
			? extensionChoice
			: [...defaultExtensions, ...(extensionChoice?.add ?? [])].filter((name) => !extensionChoice?.remove?.includes(name)));
		const toolChoice = agent.tools;
		const defaultTools = registry.tools().filter(({ extension }) => selectedExtensions.has(extension.name)).map(({ tool }) => tool.name);
		const selectedTools = new Set(Array.isArray(toolChoice) ? toolChoice : defaultTools.filter((name) => !toolChoice?.remove.includes(name)));
		const loadedTools = registry.tools().map(({ extension, tool }) => ({
			extension: extension.name,
			name: tool.name,
			replay: tool.replay ?? "unsafe (default)",
			executionMode: tool.executionMode ?? "configured default",
			selected: selectedExtensions.has(extension.name) && selectedTools.has(tool.name),
		}));
		const recentTools = inspectRecentTools(view.entries);
		const servers = this.mcp.listServers();
		const serverNames = new Map(servers.map(({ id, name }) => [id, sanitizeToolName(name)]));
		return {
			brain: {
				model: agent.model ? { provider: agent.model.provider, modelId: agent.model.modelId } : null,
				thinkingLevel: agent.thinkingLevel ?? null,
				extensions: [...selectedExtensions],
				instructions: SYSTEM_PROMPT,
				usage: view.docs["pi.usage"] ?? null,
				sessions,
				tasks,
				pending,
				transcript: view.entries.map(transcriptItem),
				live: {
					generation: live.generation ? {
						attempt: live.generation.attempt,
						...(live.generation.retry ? { retry: live.generation.retry } : {}),
						...(live.generation.deferred ? { deferred: live.generation.deferred } : {}),
					} : null,
					run: live.run ? { turns: live.run.turns } : null,
					runFailure: live.runFailure ? { reason: live.runFailure.reason, ...(live.runFailure.detail ? { detail: live.runFailure.detail } : {}) } : null,
					compactionFailure: live.compactionFailure ?? null,
					inbox: inboxItems(view),
					compactions: live.compactions ?? [],
				},
			},
			hands: {
				loadedTools,
				nestedTools: [
					...this.computerTools().tools.map(({ name, description }) => ({ group: "workspace", name, description })),
					{ group: "web", name: "search", description: "Search the live web (createAIWebSearch)." },
					{ group: "web", name: "fetch", description: "Read one URL as Markdown or raw (fetchWeb)." },
					...this.mcp.listTools().map((tool) => ({ group: serverNames.get(tool.serverId) ?? "mcp", name: tool.name, description: tool.description ?? "No description provided." })),
				],
				currentCalls: toolCalls(live),
				recentTools,
				workspaceFiles,
				artifactRepos: artifactRepos.map(({ name, description }) => ({ name, ...(description ? { description } : {}) })),
				mcpServers: servers.map(({ id, name, server_url }) => {
					const connection = this.mcp.mcpConnections[id];
					return {
						id,
						name,
						endpoint: safeMcpEndpoint(server_url),
						state: connection?.connectionState ?? "not connected",
						...(connection?.connectionError ? { error: connection.connectionError } : {}),
					};
				}),
				inspectionErrors,
				browser: {
					name: this.browser.name,
					recentCalls: recentTools.filter((call) => call.name === "browser").map(({ name: _name, ...call }) => call),
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
			? { source: "abort button", action: "PiHarness.abort" }
			: { source: "restart button", action: "ctx.abort()", note: "restarts the Durable Object; does not use up memory" };
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
		await this.recordEvent("demo.deadline.fired", { source: "scheduled abort", interrupted }, "warn", payload.operationId);
	}

	/** Records how a run ended, only if the status still shows that run as running, so it is recorded once. */
	private async finishRun(operationId: string, update: { status: "complete"; lastResponse: string } | { status: "failed"; lastError: string }): Promise<void> {
		const status = await this.ctx.storage.get<AgentStatus>("agent:status");
		if (status?.status !== "running" || status.operationId !== operationId) return;
		await this.saveStatus(update);
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
		this.sql`INSERT INTO agent_events (event) VALUES (${JSON.stringify(event)})`;
		this.sql`DELETE FROM agent_events WHERE seq <= (SELECT MAX(seq) FROM agent_events) - ${MAX_EVENTS}`;
		console.log(JSON.stringify({ event: type, agentId: this.name, ...event }));
		this.broadcast(JSON.stringify(event));
	}
}

function send(connection: Connection, message: unknown): void {
	if (connection.readyState !== SOCKET_OPEN) return;
	try {
		connection.send(JSON.stringify(message));
	} catch {
		// The socket closed between the state check and the send.
	}
}

/** The trimmed conversation state the Event Lab gets on every change. */
function projectView(view: ConversationView): ConversationSnapshot {
	const live = (view.docs["pi.live"] ?? {}) as LiveState;
	const message = live.generation?.message;
	return {
		entries: view.entries.slice(-30).map(transcriptItem),
		running: live.run !== undefined,
		...(live.run ? { turns: live.run.turns } : {}),
		...(message ? { streaming: { role: message.role, content: messageContent(message).slice(-8_000), text: messageText(message).slice(-8_000) } } : {}),
		...(live.generation?.retry ? { retry: live.generation.retry } : {}),
		tools: toolCalls(live),
		...(live.runFailure ? { runFailure: { reason: live.runFailure.reason, ...(live.runFailure.detail ? { detail: live.runFailure.detail } : {}) } } : {}),
		compactions: (live.compactions ?? []).slice(-5),
		inbox: inboxItems(view).slice(-10),
		usage: view.docs["pi.usage"],
	};
}

function toolCalls(live: LiveState): ToolCallView[] {
	return [
		...(live.tools ?? []).map((slot) => ({ slot, nested: false })),
		...(live.nestedTools ?? []).map((slot) => ({ slot, nested: true })),
	].map(({ slot, nested }) => ({
		name: slot.name,
		status: slot.status,
		...(nested ? { nested } : {}),
		...(slot.output ? { output: slot.output.slice(-2_000) } : {}),
		...(slot.diagnostics?.length ? { diagnostics: slot.diagnostics } : {}),
	}));
}

function inboxItems(view: ConversationView): readonly unknown[] {
	const inbox = view.docs["pi.inbox"] as { items?: unknown[] } | undefined;
	return inbox?.items ?? [];
}

function transcriptItem(entry: EntryRecord): TranscriptItem {
	return { id: String(entry.id), kind: entry.kind, messages: (entry.model ?? []).map(inspectMessage) };
}

function assistantEntryText(entry: EntryRecord | undefined): string {
	const message = entry?.model?.[0];
	if (message?.role !== "assistant") return "";
	return message.content.map((part) => part.type === "text" ? part.text : "").join("");
}

type ContentPart = Record<string, unknown>;

function contentParts(content: unknown): ContentPart[] {
	if (Array.isArray(content)) return content.filter((part): part is ContentPart => Boolean(part) && typeof part === "object");
	if (typeof content === "string") return [{ type: "text", text: content }];
	return [];
}

function messageContent(message: { content?: unknown }): string {
	return contentParts(message.content).flatMap((part) => {
		if (part.type === "text" && typeof part.text === "string") return [part.text];
		if (part.type === "toolCall" && typeof part.name === "string") {
			return [`Tool call: ${part.name}${part.arguments === undefined ? "" : ` ${JSON.stringify(part.arguments)}`}`];
		}
		return [];
	}).join("\n");
}

function messageText(message: { content?: unknown }): string {
	return contentParts(message.content).flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

function inspectMessage(message: unknown) {
	const value = message as { role?: string; content?: unknown; toolName?: string };
	const content = value.role === "toolResult"
		? `Tool result${value.toolName ? ` ${value.toolName}` : ""}: ${messageText(value)}`
		: messageContent(value);
	return { role: value.role ?? "unknown", content: content.slice(0, 2_000) };
}

function inspectRecentTools(entries: readonly EntryRecord[]): AgentInspection["hands"]["recentTools"] {
	const results = new Map<string, { result?: string; isError?: boolean }>();
	const calls: Array<{ id?: string; item: AgentInspection["hands"]["recentTools"][number] }> = [];
	for (const entry of entries) {
		for (const message of entry.model ?? []) {
			const value = message as { role?: string; toolCallId?: string; content?: unknown; isError?: boolean };
			if (value.role === "toolResult" && typeof value.toolCallId === "string") {
				results.set(value.toolCallId, { result: messageText(value).slice(0, 1_000), isError: value.isError === true });
			}
			for (const part of contentParts(value.content)) {
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

function unansweredMessage(reason: string | undefined): string {
	return `Pi Durable run ended unanswered: ${reason ?? "unknown reason"}`;
}

function parseMcpServers(value: string | undefined) {
	return value ? decodeMcpServers(value) : [];
}

function safeMcpEndpoint(value: string): string {
	try {
		return new URL(value).origin;
	} catch {
		return "configured endpoint";
	}
}

