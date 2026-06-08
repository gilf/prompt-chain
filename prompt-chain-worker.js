import { MessageContext } from "./consts.js";

export class Tool {
    constructor(name, description, executeFn) {
        this.name = name;
        this.description = description;
        this.executeFn = executeFn;
    }
}

export function createAgentWorker(toolsArray, maxIterations = 7) {
    let msgId = 0;
    const resolvers = new Map();
    const toolsMap = new Map(toolsArray.map(t => [t.name, t]));

    // Schema to force the LLM to choose between thinking, acting, or answering
    const agentSchema = {
        "type": "object",
        "properties": {
            "thought": { "type": "string", "description": "Reasoning for the current step." },
            "toolName": { "type": "string", "description": "Name of tool to use. Empty if no tool needed." },
            "toolInput": { "type": "string", "description": "Input for the tool." },
            "finalAnswer": { "type": "string", "description": "The final answer. Empty if using a tool." }
        },
        "required": ["thought", "toolName", "toolInput", "finalAnswer"],
    };

    function askLLM(prompt) {
        return new Promise((resolve, reject) => {
            const id = ++msgId;
            resolvers.set(id, { resolve, reject });
            self.postMessage({ id, type: MessageContext.llmRequest, payload: { prompt, schema: agentSchema } });
        });
    }

    function logToMain(message) {
        self.postMessage({ id: 0, type: MessageContext.agentLog, payload: message });
    }

    async function runReActLoop(userPrompt) {
        let isComplete = false;
        let finalResult = "";
        let loopCount = 0;

        // Inject available tools into the conversation context
        const toolDescriptions = toolsArray.map(t => `- ${t.name}: ${t.description}`).join('\n');
        let context = `System: You are an AI agent. Think step-by-step.
            Available tools:
            ${toolDescriptions}
            - none: Use this if you do not need a tool and can answer the user directly.
            
            Rules:
            1. If you need data, set "toolName" to a tool and "toolInput" to the query. Leave "finalAnswer" as "".
            2. If you know the answer, set "toolName" to "none" and put the answer in "finalAnswer".
            
            Conversation:
            User: ${userPrompt}\n`;

        while (!isComplete && loopCount < maxIterations) {
            loopCount++;

            const responseText = await askLLM(`${context}\nOutput your next step as JSON:`);
            let response;
            try {
                response = JSON.parse(responseText);
            } catch (e) {
                context += `Observation: Invalid JSON format. Please output strictly valid JSON.\n`;
                continue;
            }

            if (response.thought) {
                logToMain(`Thought: ${response.thought}`);
            }

            if (response.finalAnswer && response.finalAnswer.trim() !== "") {
                finalResult = response.finalAnswer;
                isComplete = true;
            } else if (response.toolName && response.toolName !== "none" && toolsMap.has(response.toolName)) {
                logToMain(`Action: Running ${response.toolName} with input "${response.toolInput}"`);

                try {
                    const tool = toolsMap.get(response.toolName);
                    const toolResult = await tool.executeFn(response.toolInput);

                    context += `Action: ${response.toolName}("${response.toolInput}")\n`;
                    context += `Observation: ${toolResult}\n`;
                    logToMain(`Observation: ${toolResult}`);
                } catch (err) {
                    context += `Observation: Tool failed with error: ${err.message}\n`;
                }
            } else if (response.toolName === "none" || response.toolName === "") {
                // Edge case: Model selected none, but forgot to populate finalAnswer
                context += `Observation: You selected no tools, but didn't provide a finalAnswer. Please provide the final answer.\n`;
            }
            else {
                // Fallback: Model hallucinated a tool that doesn't exist
                context += `Observation: Tool '${response.toolName}' does not exist. Use an available tool or 'none'.\n`;
            }
        }

        return finalResult || "Error: Reached maximum iterations.";
    }

    self.addEventListener('message', async (e) => {
        const { id, type, payload } = e.data;

        if (type === MessageContext.llmResponse) {
            resolvers.get(id)?.resolve(payload);
            resolvers.delete(id);
        } else if (type === MessageContext.llmError) {
            resolvers.get(id)?.reject(new Error(payload));
            resolvers.delete(id);
        } else if (type === MessageContext.startLoop) {
            try {
                const answer = await runReActLoop(payload);
                self.postMessage({ id, type: MessageContext.agentComplete, payload: answer });
            } catch (err) {
                self.postMessage({ id, type: MessageContext.agentError, payload: err.message });
            }
        }
    });
}