import { Runnable } from './runnable.js';
import { StructuredOutputRunnable } from './structured-output-runnable.js';
import { RunnableLambda } from './runnable-lambda.js';
import { CallbackEvents } from '../consts.js';

export class AgentSupervisor extends Runnable {
    constructor({ agents = [], systemPrompt = null, llmRunnable = null, askLLM = null, schema = null } = {}) {
        super();
        this.agents = agents;
        this.systemPrompt = systemPrompt;
        this.llmRunnable = llmRunnable;
        this.askLLM = askLLM;
        
        this.schema = schema || {
            type: "object",
            properties: {
                next: { 
                    type: "string", 
                    description: "The name of the next worker to act, or FINISH if the task is complete." 
                },
                reason: { 
                    type: "string", 
                    description: "Brief rationale for selecting this worker or finishing." 
                }
            },
            required: ["next", "reason"]
        };
    }

    _buildPrompt(state) {
        const agentDescriptions = this.agents.map(a => `- ${a.name}: ${a.description || 'No description provided'}`).join('\n');
        
        let prompt = this.systemPrompt || `You are a supervisor managing a team of specialized AI workers. Your job is to select the next worker to act based on the user request and the current conversation state.\n\nAvailable Workers:\n${agentDescriptions}\n- FINISH: Select FINISH when the overall user request has been fully answered or completed.\n\nRespond strictly in JSON with 'next' (the exact worker name or FINISH) and 'reason'.`;

        if (state.userPrompt) {
            prompt += `\n\nUser Prompt: ${state.userPrompt}`;
        }
        
        if (state.messages && Array.isArray(state.messages) && state.messages.length > 0) {
            const historyStr = state.messages.map(m => {
                if (typeof m === "string") return m;
                if (m.role || m.constructor?.name) {
                    const role = m.role || m.constructor.name.replace("Message", "");
                    return `${role}: ${m.content || m.text || JSON.stringify(m)}`;
                }
                return JSON.stringify(m);
            }).join('\n');
            prompt += `\n\nConversation History:\n${historyStr}`;
        } else if (state.lastObservation) {
            prompt += `\n\nLast Observation: ${state.lastObservation}`;
        }

        prompt += `\n\nWho should act next? Output JSON:`;
        return prompt;
    }

    async invoke(state, config = {}) {
        const prompt = this._buildPrompt(state);
        const logToMain = state.logToMain || config.logToMain || (() => {});
        const askLLMFn = state.askLLM || this.askLLM;

        let runner = this.llmRunnable;
        if (!runner) {
            if (typeof askLLMFn !== "function") {
                throw new Error("AgentSupervisor requires either llmRunnable or askLLM in state/constructor.");
            }
            runner = new RunnableLambda(async (p) => await askLLMFn(p, this.schema));
        }

        const structuredRunner = new StructuredOutputRunnable(runner, this.schema);
        
        logToMain("Thought [Supervisor]: Evaluating team state and deciding next worker...");
        const res = await structuredRunner.invoke(prompt, config);

        if (!res.success || !res.parsed) {
            logToMain(`Observation [Supervisor]: Failed to parse routing decision (${res.error}). Defaulting to FINISH.`);
            return { next: "__END__", supervisorReason: `Error parsing routing decision: ${res.error}` };
        }

        const { next, reason } = res.parsed;
        logToMain(`Thought [Supervisor]: Routing to '${next}' because: ${reason}`);
        
        config.callbacks?.dispatch(CallbackEvents.supervisorRoute || "on_supervisor_route", { next, reason });

        return {
            next,
            supervisorReason: reason
        };
    }
}


export function createAgentSupervisor(options = {}) {
    return new AgentSupervisor(options);
}
