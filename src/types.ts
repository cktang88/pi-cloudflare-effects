
export interface Env extends Cloudflare.Env {
	AI_GATEWAY_ID?: string;
	MODEL_ID?: string;
	MCP_SERVERS_JSON?: string;
}

export interface RunInput {
	prompt: string;
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

export type DemoInterrupt = "deadline" | "resource-limit";

export interface AgentInspection {
	brain: {
		model: { provider: string; modelId: string } | null;
		thinkingLevel: string | null;
		extensions: unknown;
		instructions: string;
		usage: unknown;
		sessions: Array<{ id: string; parent?: string; busy: boolean }>;
		pending: Array<{ operationId: string; session: string; status: string }>;
		transcript: Array<{ id: string; kind: string; messages: Array<{ role: string; content: string }> }>;
		live: { generation: unknown; inbox: readonly unknown[] };
	};
	hands: {
		loadedTools: Array<{ extension: string; name: string; replay: string; executionMode: string; selected: boolean }>;
		nestedTools: Array<{ group: string; name: string; description: string }>;
		currentCalls: Array<{ name: string; status: string; output?: string; diagnostics?: unknown[] }>;
	};
}
