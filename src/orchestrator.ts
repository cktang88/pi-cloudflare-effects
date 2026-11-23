import { Agent as DurableAgent, getAgentByName } from "agents";
import { traced } from "./observability";
import type { AgentEvent, AgentInspection, AgentStatus, DemoInterrupt, Env, LaunchOptions, LaunchResult, MessageOptions, RunResult, WaitDecision } from "./types";

const AGENT_PREFIX = "pi-agent:";

export class Orchestrator extends DurableAgent<Env> {
	async launch(prompt: string, options: LaunchOptions = {}): Promise<LaunchResult> {
		const agentId = crypto.randomUUID();
		return traced("orchestrator.launch", { "agent.id": agentId }, async () => {
			await this.ctx.storage.put(`${AGENT_PREFIX}${agentId}`, { createdAt: Date.now() });
			const agent = await getAgentByName(this.env.PI_AGENT, agentId);
			const { operationId, seeded } = await agent.launch(prompt, options);
			return { agentId, operationId, seeded };
		});
	}

	async runAgent(agentId: string, prompt: string): Promise<RunResult> {
		return traced("orchestrator.run_agent", { "agent.id": agentId }, async () => {
			const agent = await this.findAgent(agentId);
			if (!agent) throw new Error(`Agent ${agentId} not found`);
			const result = await agent.run(prompt);
			return { agentId, text: result.text };
		});
	}

	async getAgentStatus(agentId: string): Promise<AgentStatus | null> {
		return traced("orchestrator.agent_status", { "agent.id": agentId }, async () => {
			const agent = await this.findAgent(agentId);
			return agent ? agent.getStatus() : null;
		});
	}

	async getAgentEvents(agentId: string): Promise<AgentEvent[] | null> {
		const agent = await this.findAgent(agentId);
		return agent ? agent.getEvents() : null;
	}

	async inspectAgent(agentId: string): Promise<AgentInspection | null> {
		const agent = await this.findAgent(agentId);
		return agent ? agent.inspectBrainAndHands() : null;
	}

	async interruptDemoRun(agentId: string, cause: DemoInterrupt) {
		const agent = await this.findAgent(agentId);
		if (!agent) throw new Error(`Agent ${agentId} not found`);
		if (cause !== "runtime-crash") return agent.interruptDemoRun(cause);
		const previousBootId = await agent.getRuntimeBootId();
		let interruptionError: unknown;
		try {
			const result = await agent.interruptDemoRun(cause);
			if (!result.interrupted) return result;
		} catch (error) {
			interruptionError = error;
		}
		const recovery = await agent.resumeDemoRun();
		const events = await agent.getEvents();
		const restartWasRequested = events.some((event) => event.type === "demo.runtime.restart_requested" && event.operationId === recovery.operationId);
		if (restartWasRequested && recovery.operationId && recovery.bootId !== previousBootId) {
			return { interrupted: true, resumed: recovery.resumed, operationId: recovery.operationId, status: recovery.status };
		}
		if (restartWasRequested && recovery.bootId === previousBootId) {
			throw new Error("The Durable Object did not restart. Check Wrangler output; local Wrangler may not support ctx.abort. Set package.config.dev to false to run this experiment against Cloudflare.", { cause: interruptionError });
		}
		if (interruptionError !== undefined) throw interruptionError;
		throw new Error("The Durable Object did not restart after the crash request.");
	}

	async resumeDemoRun(agentId: string) {
		const agent = await this.findAgent(agentId);
		if (!agent) throw new Error(`Agent ${agentId} not found`);
		return agent.resumeDemoRun();
	}

	async armDemoDeadline(agentId: string, seconds: number) {
		const agent = await this.findAgent(agentId);
		if (!agent) throw new Error(`Agent ${agentId} not found`);
		return agent.armDemoDeadline(seconds);
	}

	// Like the methods above, these return null for an unknown agent, which the router answers with 404.
	async sendMessage(agentId: string, prompt: string, options: MessageOptions) {
		const agent = await this.findAgent(agentId);
		return agent ? agent.sendMessage(prompt, options) : null;
	}

	async continueRun(agentId: string) {
		const agent = await this.findAgent(agentId);
		return agent ? agent.continueRun() : null;
	}

	async forkSession(agentId: string, prompt?: string, note?: string) {
		const agent = await this.findAgent(agentId);
		return agent ? agent.forkSession(prompt, note) : null;
	}

	async answerWait(agentId: string, key: string, decision: WaitDecision) {
		const agent = await this.findAgent(agentId);
		return agent ? agent.answerWait(key, decision) : null;
	}

	async reconnectMcp(agentId: string, serverId: string) {
		const agent = await this.findAgent(agentId);
		return agent ? agent.reconnectMcp(serverId) : null;
	}

	async listAgents(): Promise<Array<{ name: string; createdAt: number }>> {
		return traced("orchestrator.list_agents", {}, async () => {
			const records = await this.ctx.storage.list<{ createdAt: number }>({ prefix: AGENT_PREFIX });
			return [...records].map(([key, record]) => ({ name: key.slice(AGENT_PREFIX.length), createdAt: record.createdAt }));
		});
	}

	private async findAgent(agentId: string) {
		if (!(await this.ctx.storage.get(`${AGENT_PREFIX}${agentId}`))) return null;
		return await getAgentByName(this.env.PI_AGENT, agentId);
	}
}
