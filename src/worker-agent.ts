import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createAITools } from "@cloudflare/computer/tools";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import { configure, createRegistry, defineExtension, defineTool, Harness, section, type Conversation, type EntryRecord, type ToolRegistration } from "@earendil-works/pi-durable";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import { Agent as DurableAgent } from "agents";
import { Lifecycle, LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { createBrowserTools } from "agents/browser/ai";
import { CLOUDFLARE_PROVIDER_ID, createAI } from "agents/models/pi-ai";
import { tool } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import { withObservability } from "./observability";
import { DurableObjectFiles } from "./durable-files";
import type { AgentStatus, Env } from "./types";

const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";
const CORE_EXTENSION = "cloudflare-agent-tools";
const SUBAGENT_EXTENSION = "durable-subagents";
const SYSTEM_PROMPT = `You are a careful, resourceful agent running on Pi Durable. Your conversation, tasks, and submissions are durable and resumable. You have a persistent workspace, a resumable Linux sandbox, web search, browser access, and connected MCP tools. Use code_mode to combine short multi-step tool work. Keep durable facts that will help future runs in /memory.md in the workspace. Work in small verified steps, and report important actions and errors clearly.`;

type AiTool = {
	description?: string;
	inputSchema: z.ZodType;
	execute?: (args: Record<string, unknown>, options: { toolCallId: string; messages: [] }) => Promise<unknown>;
};

type PiRuntime = { harness: Harness; root: Conversation };

export class PiAgent extends DurableAgent<Env> {
	private mcpServersAdded = false;
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
	readonly piLifecycle = new PiDurableLifecycle(this);
	readonly lifecycle = Lifecycle.install(this).use(this.mcp).use(this.piLifecycle);

	async onStart(): Promise<void> {
		if (!(await this.ctx.storage.get<AgentStatus>("agent:status"))) {
			await this.saveStatus({ status: "idle" });
		}
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
				await this.saveStatus({ status: "running" });
				const operationId = crypto.randomUUID();
				const runtime = await this.openRuntime();
				try {
					const submission = await runtime.root.submit({ type: "input", content: prompt, requestId: operationId }, BACKGROUND_CONTEXT);
					await this.saveStatus({ status: "running", operationId });
					const settled = await submission.wait(BACKGROUND_CONTEXT);
					if (settled.status !== "done") throw new Error(settled.reason ?? "Pi Durable conversation did not complete");
					const text = settled.type === "input" ? await readAssistantText(runtime.root, settled.answer) : "";
					await this.saveSandbox();
					await this.saveStatus({ status: "complete", lastResponse: text });
					return { text };
				} finally {
					await runtime.harness.close(BACKGROUND_CONTEXT);
				}
			},
			catch: (cause) => new Error("Pi Durable run failed", { cause }),
		}).pipe(
			Effect.withSpan("agent.run", { attributes: { agentId: this.ctx.id.toString() } }),
			withObservability,
		);
		try {
			return await Effect.runPromise(program);
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
		const operationId = crypto.randomUUID();
		await this.piLifecycle.wake();
		const runtime = await this.openRuntime();
		try {
			await runtime.root.submit({ type: "input", content: prompt, requestId: operationId }, BACKGROUND_CONTEXT);
			await this.saveStatus({ status: "running", operationId });
		} finally {
			await runtime.harness.close(BACKGROUND_CONTEXT);
		}
		await this.piLifecycle.wake();
		return { operationId };
	}

	async resumePiWork(): Promise<boolean> {
		const runtime = await this.openRuntime();
		try {
			const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
			return inspection.tasks.length > 0 || inspection.submissions.length > 0;
		} finally {
			await runtime.harness.close(BACKGROUND_CONTEXT);
		}
	}

	async waitForPiIdle(signal: AbortSignal): Promise<void> {
		const runtime = await this.openRuntime();
		try {
			await runtime.root.waitForIdle(withAbortSignal(signal, BACKGROUND_CONTEXT));
		} finally {
			await runtime.harness.close(BACKGROUND_CONTEXT);
		}
	}

	private async openRuntime(): Promise<PiRuntime> {
		await this.connectMcpServers();
		await this.mcp.waitForConnections({ timeout: 10_000 });
		const models = createModels();
		models.setProvider(this.ai.provider);
		const computerTools = createAITools({ workspace: this.workspace, shell: {
			defaultBackend: "shell",
			backends: { shell: { description: "Persistent workspace files and Artifacts Git repositories." } },
		} });
		const browserTools = createBrowserTools({ ctx: this.ctx, browser: this.env.BROWSER, loader: this.env.LOADER, session: { mode: "dynamic" } });
		const webSearch = tool({
			description: "Search the live web for current facts and sources.",
			inputSchema: z.object({ query: z.string().min(1).max(1024), limit: z.number().int().min(1).max(10).optional() }),
			execute: async ({ query, limit }) => {
				const response = await this.env.AI.websearch({ gatewayId: this.env.AI_GATEWAY_ID ?? "default", query, limit: limit ?? 5 });
				return response.json();
			},
		});
		const codeMode = createCodeTool({
			tools: [
				{ name: "workspace", tools: computerTools },
				{ name: "browser", tools: browserTools },
				{ name: "mcp", tools: this.mcp.getAITools() },
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
		const storage = await JsonlStorage.open("sessions", new DurableObjectFiles(this.ctx.storage, this.ctx.id.toString()), BACKGROUND_CONTEXT);
		try {
			const harness = await Harness.open(storage, { models, registry: this.registry }, BACKGROUND_CONTEXT);
			harness.resume();
			const root = await harness.root(BACKGROUND_CONTEXT, {
				agent: {
					model: { provider: CLOUDFLARE_PROVIDER_ID, modelId: this.env.MODEL_ID ?? DEFAULT_MODEL },
					extensions: [coreExtension, subagentExtension],
				},
			});
			return { harness, root };
		} catch (error) {
			await storage.close(BACKGROUND_CONTEXT);
			throw error;
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
			agentId: this.ctx.id.toString(), status: "idle", updatedAt: new Date(0).toISOString(),
		};
		if (status.status !== "running" || !status.operationId) return status;
		await this.piLifecycle.wake();
		const runtime = await this.openRuntime();
		try {
			const submission = await runtime.root.commit((tx) => tx.submissionByRequest(runtime.root.id, status.operationId!), BACKGROUND_CONTEXT);
			if (!submission || submission.status === "queued" || submission.status === "placed") return status;
			if (submission.status === "done") {
				const text = submission.type === "input" ? await readAssistantText(runtime.root, submission.answer) : "";
				await this.saveStatus({ status: "complete", operationId: status.operationId, lastResponse: text });
			} else {
				await this.saveStatus({ status: "failed", operationId: status.operationId, lastError: submission.reason });
			}
		} finally {
			await runtime.harness.close(BACKGROUND_CONTEXT);
		}
		return (await this.ctx.storage.get<AgentStatus>("agent:status")) ?? status;
	}

	private async saveStatus(update: Partial<AgentStatus> & Pick<AgentStatus, "status">): Promise<void> {
		const previous = await this.ctx.storage.get<AgentStatus>("agent:status");
		const status: AgentStatus = {
			agentId: this.ctx.id.toString(), status: update.status,
			updatedAt: new Date().toISOString(),
			...(update.lastError ? { lastError: update.lastError } : {}),
			...(update.lastResponse ? { lastResponse: update.lastResponse } : {}),
			...(update.operationId ? { operationId: update.operationId } : {}),
		};
		if (update.status === "running") status.lastResponse = previous?.lastResponse;
		await this.ctx.storage.put("agent:status", status);
		console.log(JSON.stringify({ event: "agent.status", ...status }));
	}
}

async function readAssistantText(conversation: Conversation, entryId: Parameters<Conversation["entries"]>[0]["minEntryId"]): Promise<string> {
	const page = await conversation.entries({ minEntryId: entryId, maxEntryId: entryId }, 1, undefined, BACKGROUND_CONTEXT);
	return assistantEntryText(page.items[0]);
}

function assistantEntryText(entry: EntryRecord | undefined): string {
	const message = entry?.model?.[0];
	if (message?.role !== "assistant") return "";
	return message.content.map((part) => part.type === "text" ? part.text : "").join("");
}

class PiDurableLifecycle extends LifecycleCapability {
	private readonly agent: PiAgent;
	private waiting = false;

	constructor(agent: PiAgent) {
		super("pi-durable-runtime");
		this.agent = agent;
	}

	async onStart(): Promise<void> {
		if (await this.agent.resumePiWork()) await this.wake();
	}

	async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
		if (context.job.fn !== "pi-durable-wake") return undefined;
		if (this.waiting) return { rescheduleAt: Date.now() + 30_000 };
		if (!(await this.agent.resumePiWork())) return undefined;
		this.waiting = true;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10 * 60_000);
		const work = this.agent.waitForPiIdle(controller.signal).catch((error: unknown) => {
			if (!controller.signal.aborted) {
				this.lifecycle.events.emit("pi_durable:wake_error", { error: error instanceof Error ? error.message : String(error) });
			}
		}).finally(() => {
			clearTimeout(timer);
			this.waiting = false;
			void this.wake().catch((error: unknown) => {
				this.lifecycle.events.emit("pi_durable:wake_error", { error: error instanceof Error ? error.message : String(error) });
			});
		});
		this.lifecycle.trackAlarmWork(work);
		return { rescheduleAt: Date.now() + 30_000 };
	}

	wake(): Promise<unknown> {
		return this.lifecycle.jobs.push({ id: "pi-durable-root", fn: "pi-durable-wake", time: Date.now(), singleflight: true, recoveryLoop: true });
	}
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
	const startedAt = Date.now();
	return Effect.runPromise(Effect.tryPromise({
		try: run,
		catch: (cause) => new Error(`Tool ${name} failed`, { cause }),
	}).pipe(Effect.withSpan(`agent.tool.${name}`), withObservability)).then((result) => {
		console.log(JSON.stringify({ event: "agent.tool", name, outcome: "ok", durationMs: Date.now() - startedAt }));
		return result;
	}, (error: unknown) => {
		console.error(JSON.stringify({ event: "agent.tool", name, outcome: "error", durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }));
		throw error;
	});
}
