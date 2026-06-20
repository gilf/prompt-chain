import { MessageContext } from "./consts.js";
import { AgentMemory } from "./agent-memory.js";
import { PromptTemplate } from "./prompt-template.js";
import { ToolRetriever } from "./tool-retriever.js";
import { SkillRetriever } from "./skill-retriever.js";
import { isRecoverableError, runWithTimeout, delay, compressHistory } from "./utils.js";

export class Tool {
    constructor(name, description, executeFn) {
        this.name = name;
        this.description = description;
        this.executeFn = executeFn;
    }
}

export function createAgentWorker(toolsArray, skillsArray = []) {
    let msgId = 0;
    const resolvers = new Map();

    const memory = new AgentMemory();
    const toolRetriever = new ToolRetriever(toolsArray);
    const skillRetriever = new SkillRetriever(skillsArray);
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

    function askLLM(prompt, schema = agentSchema) {
        return new Promise((resolve, reject) => {
            const id = ++msgId;
            resolvers.set(id, { resolve, reject });
            self.postMessage({ id, type: MessageContext.llmRequest, payload: { prompt, schema } });
        });
    }

    function logToMain(message) {
        self.postMessage({ id: 0, type: MessageContext.agentLog, payload: message });
    }

    async function runReActLoop(userPrompt, sessionId) {
        let isComplete = false;
        let finalResult = "";
        let loopCount = 0;

        let { history: historyTurns, summary: conversationSummary } = await memory.getHistory(sessionId);

        const relevantTools = await toolRetriever.getRelevantTools(userPrompt, 3);
        const relevantSkills = await skillRetriever.getRelevantSkills(userPrompt, 3);
        
        let skillInstructions = "";
        if (relevantSkills.length > 0) {
            for (const skill of relevantSkills) {
                logToMain(`System: Activating skill "${skill.name}"`);
                skillInstructions += `${skill.instructions} `;

                for (const skillTool of skill.tools) {
                    if (!relevantTools.some(t => t.name === skillTool.name)) {
                        relevantTools.push(skillTool);
                    }
                }
            }
        }
        
        const toolsMap = new Map(relevantTools.map(t => [t.name, t]));

        let currentTurnLog = `User: ${userPrompt}\n`;
        let currentPrompt = promptTemplate.format(relevantTools, historyTurns, userPrompt, conversationSummary, skillInstructions);

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

                const tool = toolsMap.get(response.toolName);
                let toolResult;
                let success = false;
                let retryCount = 0;
                const maxRetries = 3;

                while (retryCount <= maxRetries && !success) {
                    try {
                        toolResult = await runWithTimeout(tool.executeFn, response.toolInput, 3000);
                        success = true;
                    } catch (err) {
                        if (isRecoverableError(err) && retryCount < maxRetries) {
                            retryCount++;
                            logToMain(`Observation: Tool timed out. Retrying...`);
                            await delay(1000);
                        } else {
                            currentTurnLog += `Action: ${response.toolName}("${response.toolInput}")\nObservation: Tool failed with error: ${err.message}\n`;
                            logToMain(`Observation: Tool failed with error: ${err.message}`);
                            currentPrompt = `Observation: Tool '${response.toolName}' failed because: ${err.message}. Please correct the input/parameters, try a different approach, or check tool availability, and try again.`;
                            break;
                        }
                    }
                }

                if (success) {
                    currentTurnLog += `Action: ${response.toolName}("${response.toolInput}")\nObservation: ${toolResult}\n`;
                    logToMain(`Observation: ${toolResult}`);
                    currentPrompt = `Observation from ${response.toolName}: ${toolResult}\nGiven this observation, output your next step as JSON:`;
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
            const compressionResult = await compressHistory(historyTurns, conversationSummary, askLLM, logToMain);
            await memory.saveHistory(sessionId, compressionResult.historyTurns, compressionResult.updatedSummary);
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
