
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
