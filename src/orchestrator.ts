import { Agent as DurableAgent, getAgentByName } from "agents";
import { Effect } from "effect";
import { withCloudflareSpan, withObservability } from "./observability";
import type { AgentEvent, AgentInspection, AgentStatus, DemoInterrupt, Env, LaunchResult, RunResult } from "./types";

const AGENT_PREFIX = "pi-agent:";

export class Orchestrator extends DurableAgent<Env> {
	async launch(prompt: string): Promise<LaunchResult> {
		const agentId = crypto.randomUUID();
		return withCloudflareSpan("orchestrator.launch", { "agent.id": agentId }, () => {
			const program = Effect.tryPromise({
				try: async () => {
					await this.ctx.storage.put(`${AGENT_PREFIX}${agentId}`, { createdAt: Date.now() });
					const agent = await getAgentByName(this.env.PI_AGENT, agentId);
					const result = await agent.launch(prompt);
					return { agentId, operationId: result.operationId };
				},
				catch: (cause) => new Error("Could not launch Pi agent", { cause }),
			}).pipe(Effect.withSpan("orchestrator.launch", { attributes: { agentId } }), withObservability);
			return Effect.runPromise(program);
		});
	}

	async runAgent(agentId: string, prompt: string): Promise<RunResult> {
		return withCloudflareSpan("orchestrator.run_agent", { "agent.id": agentId }, async () => {
			const agent = await this.findAgent(agentId);
			if (!agent) throw new Error(`Agent ${agentId} not found`);
			const result = await agent.run(prompt);
			return { agentId, text: result.text };
		});
	}

	async getAgentStatus(agentId: string): Promise<AgentStatus | null> {
		return withCloudflareSpan("orchestrator.agent_status", { "agent.id": agentId }, async () => {
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
		return agent.interruptDemoRun(cause);
	}

	async armDemoDeadline(agentId: string, seconds: number) {
		const agent = await this.findAgent(agentId);
		if (!agent) throw new Error(`Agent ${agentId} not found`);
		return agent.armDemoDeadline(seconds);
	}

	async listAgents(): Promise<Array<{ name: string; createdAt: number }>> {
		return withCloudflareSpan("orchestrator.list_agents", {}, async () => {
			const records = await this.ctx.storage.list<{ createdAt: number }>({ prefix: AGENT_PREFIX });
			return [...records].map(([key, record]) => ({ name: key.slice(AGENT_PREFIX.length), createdAt: record.createdAt }));
		});
	}

	private async findAgent(agentId: string) {
		if (!(await this.ctx.storage.get(`${AGENT_PREFIX}${agentId}`))) return null;
		return await getAgentByName(this.env.PI_AGENT, agentId);
	}
}
