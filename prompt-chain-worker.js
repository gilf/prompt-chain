import { MessageContext } from "./consts.js";
import { AgentMemory } from "./agent-memory.js";
import { PromptTemplate } from "./prompt-template.js";
import { ToolRetriever } from "./tool-retriever.js";

export class Tool {
    constructor(name, description, executeFn) {
        this.name = name;
        this.description = description;
        this.executeFn = executeFn;
    }
}

export function createAgentWorker(toolsArray) {
    let msgId = 0;
    const resolvers = new Map();

    const memory = new AgentMemory();
    const toolRetriever = new ToolRetriever(toolsArray);
    const promptTemplate = new PromptTemplate();

    const agentSchema = {
        "type": "object",
        "properties": {
            "thought": { "type": "string" },
            "toolName": { "type": "string" },
            "toolInput": { "type": "string" },
            "finalAnswer": { "type": "string" }
        },
        "required": ["thought", "toolName", "toolInput", "finalAnswer"]
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

    async function runReActLoop(userPrompt, sessionId) {
        let isComplete = false;
        let finalResult = "";
        let loopCount = 0;

        const historyTurns = await memory.getHistory(sessionId);
        const relevantTools = await toolRetriever.getRelevantTools(userPrompt, 3);
        const toolsMap = new Map(relevantTools.map(t => [t.name, t]));

        let currentTurnLog = `User: ${userPrompt}\n`;
        let currentPrompt = promptTemplate.format(relevantTools, historyTurns, userPrompt);

        while (!isComplete && loopCount < 7) {
            loopCount++;

            const responseText = await askLLM(currentPrompt);
            let response;

            try {
                response = JSON.parse(responseText);
            } catch (e) {
                currentPrompt = `Observation: Invalid JSON format received. You must respond strictly in JSON syntax.`;
                continue;
            }

            if (response.thought) {
                logToMain(`Thought: ${response.thought}`);
                currentTurnLog += `Thought: ${response.thought}\n`;
            }

            if (response.finalAnswer && response.finalAnswer.trim() !== "") {
                finalResult = response.finalAnswer;
                currentTurnLog += `Assistant: ${response.finalAnswer}\n`;
                isComplete = true;
            }
            else if (response.toolName && response.toolName !== "none" && toolsMap.has(response.toolName)) {
                logToMain(`Action: Running ${response.toolName} with input "${response.toolInput}"`);

                try {
                    const tool = toolsMap.get(response.toolName);
                    const toolResult = await tool.executeFn(response.toolInput);

                    currentTurnLog += `Action: ${response.toolName}("${response.toolInput}")\nObservation: ${toolResult}\n`;
                    logToMain(`Observation: ${toolResult}`);
                    currentPrompt = `Observation from ${response.toolName}: ${toolResult}\nGiven this observation, output your next step as JSON:`;

                } catch (err) {
                    currentTurnLog += `Observation: Tool failed with error: ${err.message}\n`;
                    currentPrompt = `Observation: Tool failed with error: ${err.message}\nGiven this observation, output your next step as JSON:`;
                }
            }
            else if (response.toolName === "none" || response.toolName === "") {
                currentPrompt = `Observation: You set toolName to "none" but omitted a finalAnswer. Provide your final answer text in the JSON.`;
            }
            else {
                currentPrompt = `Observation: Tool '${response.toolName}' is not loaded. Select from available tools or use 'none'.`;
            }
        }

        if (finalResult) {
            historyTurns.push(currentTurnLog.trim());
            if (historyTurns.length > 10) historyTurns.shift();
            await memory.saveHistory(sessionId, historyTurns);
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
                await memory.init();
                const answer = await runReActLoop(payload.userPrompt, payload.sessionId);
                self.postMessage({ id, type: MessageContext.agentComplete, payload: answer });
            } catch (err) {
                self.postMessage({ id, type: MessageContext.agentError, payload: err.message });
            }
        }
    });
}
