
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
	seeded: boolean;
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

export type DemoInterrupt = "deadline" | "runtime-crash" | "abort-all";

/** One message of an existing conversation to start a new agent from (Pi 1.6 `init`). */
export interface HistoryItem {
	role: "user" | "assistant";
	text: string;
}

export interface AgentSettings {
	/** Hold exec, delete, and container_exec calls until a person allows them. */
	approvals: boolean;
	/** How long ask_human and approvals wait for a person before the deadline passes. */
	replyMinutes: number;
}

export interface LaunchOptions {
	history?: readonly HistoryItem[];
	approvals?: boolean;
	replyMinutes?: number;
}

/** An expected failure returned (not thrown) so its HTTP status survives the Durable Object RPC boundary. */
export interface RequestFailure {
	error: string;
	status: 400 | 404 | 409;
}

export function isRequestFailure(value: unknown): value is RequestFailure {
	return typeof value === "object" && value !== null && "error" in value && "status" in value && typeof (value as RequestFailure).status === "number";
}

export interface MessageOptions {
	mode: "queue" | "steer";
	keep: boolean;
}

export interface WaitDecision {
	text?: string;
	decision?: "allow" | "deny";
}

/** A tool call parked on a person, a deadline, or another session. */
export interface WaitView {
	key: string;
	taskId: string;
	kind: "question" | "approval" | "timer" | "subagent";
	tool: string;
	prompt: string;
	status: "waiting" | "answered" | "expired" | "cancelled";
	createdAt: string;
	until?: string;
	answer?: string;
}

export interface TranscriptItem {
	id: string;
	kind: string;
	messages: Array<{ role: string; content: string }>;
}

export interface ToolCallView {
	name: string;
	status: string;
	nested?: boolean;
	/** Pi 1.6: the call is parked (sleeping on a signal or deadline, or waiting on child tasks). */
	parked?: boolean;
	output?: string;
	diagnostics?: unknown[];
}

/** A trimmed copy of Pi's conversation state, sent to the Event Lab over its WebSocket. */
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
		waits: WaitView[];
		settings: AgentSettings;
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
		mcpServers: Array<{ id: string; name: string; endpoint: string; state: string; error?: string; authUrl?: string }>;
		inspectionErrors: string[];
		browser: { name: string; recentCalls: Array<{ arguments?: string; result?: string; isError?: boolean }> };
		sandbox: { containerRunning: boolean; snapshotAvailable: boolean; snapshotName?: string; snapshotSize?: number };
	};
}
