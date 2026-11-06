
export interface Env extends Cloudflare.Env {
	AI_GATEWAY_ID?: string;
	MODEL_ID?: string;
	MCP_SERVERS_JSON?: string;
}

export interface RunResult {
	agentId: string;
	text: string;
}

export interface LaunchResult {
	agentId: string;
	operationId: string;
}

export interface AgentStatus {
	agentId: string;
	status: "idle" | "running" | "complete" | "failed";
	updatedAt: string;
	lastError?: string;
	lastResponse?: string;
	operationId?: string;
}

export interface AgentEvent {
	id: string;
	at: string;
	type: string;
	level: "info" | "warn" | "error";
	operationId?: string;
	details?: Record<string, string | number | boolean>;
}

export type DemoInterrupt = "deadline" | "runtime-crash";

export interface TranscriptItem {
	id: string;
	kind: string;
	messages: Array<{ role: string; content: string }>;
}

export interface ToolCallView {
	name: string;
	status: string;
	nested?: boolean;
	output?: string;
	diagnostics?: unknown[];
}

/** A compact projection of Pi's conversation view, sent to the Event Lab over its WebSocket. */
export interface ConversationSnapshot {
	entries: TranscriptItem[];
	running: boolean;
	turns?: number;
	streaming?: { role: string; content: string; text: string };
	retry?: { at: number; error: string };
	tools: ToolCallView[];
	runFailure?: { reason: string; detail?: string };
	compactions: unknown[];
	inbox: unknown[];
	usage?: unknown;
}

export interface AgentInspection {
	brain: {
		model: { provider: string; modelId: string } | null;
		thinkingLevel: string | null;
		extensions: string[];
		instructions: string;
		usage: unknown;
		sessions: Array<{ id: string; parent?: string; busy: boolean }>;
		tasks: Array<{ id: string; kind: string; conversationId: string; owner?: string; status: string; background: boolean; abortRequested: boolean }>;
		pending: Array<{ operationId: string; session: string; status: string }>;
		transcript: TranscriptItem[];
		live: {
			generation: { attempt: number; retry?: { at: number; error: string }; deferred?: { pollAt: number } } | null;
			run: { turns: number } | null;
			runFailure: { reason: string; detail?: string } | null;
			compactionFailure: unknown;
			inbox: readonly unknown[];
			compactions: readonly unknown[];
		};
	};
	hands: {
		loadedTools: Array<{ extension: string; name: string; replay: string; executionMode: string; selected: boolean }>;
		nestedTools: Array<{ group: string; name: string; description: string }>;
		currentCalls: ToolCallView[];
		recentTools: Array<{ name: string; arguments?: string; result?: string; isError?: boolean }>;
		workspaceFiles: Array<{ path: string; type: "file" | "dir" }>;
		artifactRepos: Array<{ name: string; description?: string }>;
		mcpServers: Array<{ id: string; name: string; endpoint: string }>;
		inspectionErrors: string[];
		browser: { name: string; recentCalls: Array<{ arguments?: string; result?: string; isError?: boolean }> };
		sandbox: { containerRunning: boolean; snapshotAvailable: boolean; snapshotName?: string; snapshotSize?: number };
	};
}
