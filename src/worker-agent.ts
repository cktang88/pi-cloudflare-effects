import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createAITools } from "@cloudflare/computer/tools";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { Agent as DurableAgent } from "agents";
import { Lifecycle } from "agents/lifecycle";
import { PiHarness } from "agents/harnesses/pi";
import { createBrowserTools } from "agents/browser/ai";
import { CLOUDFLARE_PROVIDER_ID, createAI } from "agents/models/pi-ai";
import { tool } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import type { AgentStatus, Env } from "./types";

const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";
const SYSTEM_PROMPT = `You are a careful, resourceful agent. You have a durable workspace, a resumable Linux sandbox, web search, browser access, and connected MCP tools. Use code mode to combine short multi-step tool work. Work in small verified steps, and report important actions and errors clearly.`;

type AiTool = {
	description?: string;
	inputSchema: z.ZodType;
	execute?: (args: Record<string, unknown>, options: { toolCallId: string; messages: [] }) => Promise<unknown>;
};

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
	readonly harness = new PiHarness({
		harness: async ({ storage, context }) => {
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
				...toPiTools(computerTools),
				...toPiTools(browserTools),
				...toPiTools(mcpTools),
				...toPiTools({ web_search: webSearch, code_mode: codeMode }),
				{
						name: "container_exec",
						description: "Run a command in this agent's resumable Linux sandbox. The sandbox filesystem is separate from the workspace shell.",
						parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16_384 }) }),
						replay: "unsafe",
					execute: async (args) => ({ content: [{ type: "text", text: await traceTool("container_exec", () => this.runInContainer((args as { command: string }).command)) }] }),
				},
			];
			for (const tool of tools) this.registry.tools.add(tool);
			this.registry.systemPrompt.section("preamble", () => SYSTEM_PROMPT, { tag: false });
			return Harness.open(storage, { models, registry: this.registry }, context);
		},
		defaults: {
			model: { provider: CLOUDFLARE_PROVIDER_ID, modelId: this.env.MODEL_ID ?? DEFAULT_MODEL },
		},
	});
	readonly lifecycle = Lifecycle.install(this).use(this.mcp).use(this.harness);

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
				const receipt = await this.harness.submit(prompt);
				await this.saveStatus({ status: "running", operationId: receipt.operationId });
				const result = await this.harness.wait(receipt.operationId);
				if (result.status !== "done") throw new Error(result.reason ?? "Pi session did not complete");
				await this.saveSandbox();
				await this.saveStatus({ status: "complete", lastResponse: result.text ?? "" });
				return { text: result.text ?? "" };
			},
			catch: (cause) => new Error("Pi agent run failed", { cause }),
		}).pipe(Effect.withSpan("pi.agent.run", { attributes: { agentId: this.ctx.id.toString() } }));
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
		const receipt = await this.harness.submit(prompt);
		await this.saveStatus({ status: "running", operationId: receipt.operationId });
		return { operationId: receipt.operationId };
	}

	private async runInContainer(command: string): Promise<string> {
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
		const text = new TextDecoder().decode(output.stdout);
		const stderr = new TextDecoder().decode(output.stderr);
		return JSON.stringify({ exitCode: output.exitCode, stdout: text.slice(0, 16_000), stderr: stderr.slice(0, 8_000) });
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
		if ((await this.harness.pending()).some((operation) => operation.operationId === status.operationId)) return status;
		const result = await this.harness.wait(status.operationId);
		await this.saveStatus(result.status === "done"
			? { status: "complete", operationId: result.operationId, lastResponse: result.text ?? "" }
			: { status: "failed", operationId: result.operationId, lastError: result.reason ?? "Pi operation did not complete" });
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
	return Effect.runPromise(Effect.tryPromise({
		try: run,
		catch: (cause) => new Error(`Tool ${name} failed`, { cause }),
	}).pipe(Effect.withSpan(`pi.tool.${name}`)));
}
