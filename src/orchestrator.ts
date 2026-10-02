import { Agent as DurableAgent } from "agents";
import { Effect } from "effect";
import { PiAgent } from "./worker-agent";
import type { AgentStatus, Env, LaunchResult, RunResult } from "./types";

export class Orchestrator extends DurableAgent<Env> {
	async launch(prompt: string): Promise<LaunchResult> {
		const agentId = crypto.randomUUID();
		const program = Effect.tryPromise({
			try: async () => {
				const agent = await this.subAgent(PiAgent, agentId);
				const result = await agent.launch(prompt);
				return { agentId, operationId: result.operationId };
			},
			catch: (cause) => new Error("Could not launch Pi agent", { cause }),
		}).pipe(Effect.withSpan("orchestrator.launch", { attributes: { agentId } }));
		return Effect.runPromise(program);
	}

	async runAgent(agentId: string, prompt: string): Promise<RunResult> {
		const agent = await this.findAgent(agentId);
		if (!agent) throw new Error(`Agent ${agentId} not found`);
		const result = await agent.run(prompt);
		return { agentId, text: result.text };
	}

	async getAgentStatus(agentId: string): Promise<AgentStatus | null> {
		const agent = await this.findAgent(agentId, false);
		return agent ? agent.getStatus() : null;
	}

	async listAgents(): Promise<Array<{ name: string; createdAt: number }>> {
		return this.listSubAgents()
			.filter((agent) => agent.className === "PiAgent")
			.map(({ name, createdAt }) => ({ name, createdAt }));
	}

	private async findAgent(agentId: string, create = true) {
		if (!create && !(await this.hasSubAgent(PiAgent, agentId))) return null;
		return await this.subAgent(PiAgent, agentId);
	}
}
