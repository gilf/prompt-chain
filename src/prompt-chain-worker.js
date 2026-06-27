import { MessageContext, CallbackEvents } from "./consts.js";
import { AgentMemory } from "./agent-memory.js";
import { PromptTemplate } from "./prompt-template.js";
import { ToolRetriever } from "./tool-retriever.js";
import { SkillRetriever } from "./skill-retriever.js";
import { isRecoverableError, runWithTimeout, delay, compressHistory } from "./utils.js";
import { Runnable, RunnableSequence, RunnableParallel, RunnableLambda, RunnablePassthrough, RunnableBinding } from "./runnable.js";
import { BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage } from "./messages.js";
import { CallbackManager } from "./callbacks.js";

export { Runnable, RunnableSequence, RunnableParallel, RunnableLambda, RunnablePassthrough, RunnableBinding };
export { BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage };
export { CallbackManager };

export class Tool extends Runnable {
    constructor(name, description, executeFn, schema = null) {
        super();
        this.name = name;
        this.description = description;
        this.executeFn = executeFn;
        this.schema = schema;
    }

    async invoke(input, config = {}) {
        if (this.schema && Array.isArray(this.schema.required) && typeof input === "object" && input !== null) {
            const missing = this.schema.required.filter(key => !(key in input));
            if (missing.length > 0) {
                throw new Error(`Tool '${this.name}' missing required parameter(s): ${missing.join(", ")}`);
            }
        }
        return await runWithTimeout(this.executeFn, input, config.timeoutMs || 3000);
    }
}

export class LLMRunnable extends Runnable {
    constructor(askLLMFn, schema) {
        super();
        this.askLLMFn = askLLMFn;
        this.schema = schema;
    }
    async invoke(prompt, config = {}) {
        return await this.askLLMFn(prompt, this.schema);
    }
}

export class JSONOutputParserRunnable extends Runnable {
    async invoke(responseText, config = {}) {
        try {
            let cleanText = (responseText || "").trim();
            if (cleanText.startsWith("```json")) {
                cleanText = cleanText.slice(7).trim();
            } else if (cleanText.startsWith("```")) {
                cleanText = cleanText.slice(3).trim();
            }
            if (cleanText.endsWith("```")) {
                cleanText = cleanText.slice(0, -3).trim();
            }
            return { success: true, parsed: JSON.parse(cleanText) };
        } catch (e) {
            return { success: false, error: `Invalid JSON format received (${e.message}). You must respond strictly in JSON syntax.` };
        }
    }
}

export class ReActAgentExecutor extends Runnable {
    constructor({ tools = [], skills = [], memory, toolRetriever, skillRetriever, promptTemplate, inferenceStepChain, askLLM, logToMain, callbackManager }) {
        super();
        this.tools = tools;
        this.skills = skills;
        this.memory = memory;
        this.toolRetriever = toolRetriever;
        this.skillRetriever = skillRetriever;
        this.promptTemplate = promptTemplate;
        this.inferenceStepChain = inferenceStepChain;
        this.askLLM = askLLM;
        this.logToMain = logToMain;
        this.callbackManager = callbackManager;
    }

    async invoke({ userPrompt, sessionId }) {
        this.callbackManager?.dispatch(CallbackEvents.chainStart, { userPrompt, sessionId });

        let isComplete = false;
        let finalResult = "";
        let loopCount = 0;

        let { history: historyTurns, summary: conversationSummary } = await this.memory.getHistory(sessionId);

        const relevantTools = await this.toolRetriever.getRelevantTools(userPrompt, 3);
        const relevantSkills = await this.skillRetriever.getRelevantSkills(userPrompt, 3);
        
        let skillInstructions = "";
        if (relevantSkills.length > 0) {
            for (const skill of relevantSkills) {
                this.logToMain(`System: Activating skill "${skill.name}"`);
                skillInstructions += `${skill.instructions} `;

                for (const skillTool of skill.tools) {
                    if (!relevantTools.some(t => t.name === skillTool.name)) {
                        relevantTools.push(skillTool);
                    }
                }
            }
        }
        
        const toolsMap = new Map(relevantTools.map(t => [t.name.toLowerCase(), t]));

        let currentTurnLog = `User: ${userPrompt}\n`;
        let chainInput = { relevantTools, historyTurns, userPrompt, summary: conversationSummary, skillInstructions };

        while (!isComplete && loopCount < 7) {
            loopCount++;

            this.callbackManager?.dispatch(CallbackEvents.llmStart, { loopCount });
            const stepResult = await this.inferenceStepChain.invoke(chainInput);

            if (!stepResult.success) {
                chainInput = `Observation: ${stepResult.error}`;
                continue;
            }

            const response = stepResult.parsed;

            if (response.thought) {
                this.logToMain(`Thought: ${response.thought}`);
                currentTurnLog += `Thought: ${response.thought}\n`;
            }

            const lookupToolName = (response.toolName || "").toLowerCase();

            if (response.finalAnswer && response.finalAnswer.trim() !== "") {
                finalResult = response.finalAnswer;
                currentTurnLog += `Assistant: ${response.finalAnswer}\n`;
                isComplete = true;
            }
            else if (lookupToolName && lookupToolName !== "none" && toolsMap.has(lookupToolName)) {
                const inputLogStr = typeof response.toolInput === "object" ? JSON.stringify(response.toolInput) : response.toolInput;
                this.logToMain(`Action: Running ${response.toolName} with input ${inputLogStr}`);
                this.callbackManager?.dispatch(CallbackEvents.toolStart, { toolName: response.toolName, toolInput: response.toolInput });

                const tool = toolsMap.get(lookupToolName);
                let toolResult;
                let success = false;
                let retryCount = 0;
                const maxRetries = 3;

                while (retryCount <= maxRetries && !success) {
                    try {
                        toolResult = await tool.invoke(response.toolInput);
                        success = true;
                    } catch (err) {
                        if (isRecoverableError(err) && retryCount < maxRetries) {
                            retryCount++;
                            this.logToMain(`Observation: Tool timed out. Retrying...`);
                            await delay(1000);
                        } else {
                            currentTurnLog += `Action: ${response.toolName}(${inputLogStr})\nObservation: Tool failed with error: ${err.message}\n`;
                            this.logToMain(`Observation: Tool failed with error: ${err.message}`);
                            chainInput = `Observation: Tool '${response.toolName}' failed because: ${err.message}. Please correct the input/parameters, try a different approach, or check tool availability, and try again.`;
                            break;
                        }
                    }
                }

                if (success) {
                    currentTurnLog += `Action: ${response.toolName}(${inputLogStr})\nObservation: ${toolResult}\n`;
                    this.logToMain(`Observation: ${toolResult}`);
                    this.callbackManager?.dispatch(CallbackEvents.toolEnd, { toolName: response.toolName, toolResult });
                    chainInput = `Observation from ${response.toolName}: ${toolResult}\nGiven this observation, output your next step as JSON:`;
                }
            }
            else if (response.toolName === "none" || response.toolName === "") {
                chainInput = `Observation: You set toolName to "none" but omitted a finalAnswer. Provide your final answer text in the JSON.`;
            }
            else {
                chainInput = `Observation: Tool '${response.toolName}' is not loaded. Select from available tools or use 'none'.`;
            }
        }

        if (finalResult) {
            historyTurns.push(new HumanMessage(userPrompt));
            historyTurns.push(new AIMessage(finalResult));
            const compressionResult = await compressHistory(historyTurns, conversationSummary, this.askLLM, this.logToMain);
            await this.memory.saveHistory(sessionId, compressionResult.historyTurns, compressionResult.updatedSummary);
        }

        const finalOutput = finalResult || "Error: Reached maximum iterations.";
        this.callbackManager?.dispatch(CallbackEvents.chainEnd, { finalOutput });
        return finalOutput;
    }
}

export function createAgentWorker(toolsOrRunnable, skillsArray = [], callbacks = null) {
    let msgId = 0;
    const resolvers = new Map();
    const callbackManager = callbacks instanceof CallbackManager ? callbacks : new CallbackManager();

    const memory = new AgentMemory();

    const agentSchema = {
        "type": "object",
        "properties": {
            "thought": { "type": "string" },
            "toolName": { "type": "string" },
            "toolInput": { "type": ["string", "object", "number", "boolean", "array"] },
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

    let agentExecutor;
    if (toolsOrRunnable instanceof Runnable || typeof toolsOrRunnable?.invoke === "function") {
        agentExecutor = toolsOrRunnable;
    } else {
        const toolsArray = Array.isArray(toolsOrRunnable) ? toolsOrRunnable : [];
        const toolRetriever = new ToolRetriever(toolsArray);
        const skillRetriever = new SkillRetriever(skillsArray);
        const promptTemplate = new PromptTemplate();
        
        const llmRunnable = new LLMRunnable(askLLM, agentSchema);
        const parserRunnable = new JSONOutputParserRunnable();
        
        const inferenceStepChain = RunnableSequence.from([
            new RunnableLambda(async (promptInput) => {
                if (typeof promptInput === "string") return promptInput;
                return await promptTemplate.invoke(promptInput);
            }),
            llmRunnable,
            parserRunnable
        ]);

        agentExecutor = new ReActAgentExecutor({
            tools: toolsArray,
            skills: skillsArray,
            memory,
            toolRetriever,
            skillRetriever,
            promptTemplate,
            inferenceStepChain,
            askLLM,
            logToMain,
            callbackManager
        });
    }

    self.addEventListener('message', async (e) => {
        const { id, type, payload } = e.data;

        if (type === MessageContext.llmStreamToken) {
            callbackManager.dispatch(CallbackEvents.llmNewToken, { token: payload });
        } else if (type === MessageContext.llmResponse) {
            callbackManager.dispatch(CallbackEvents.llmEnd, { response: payload });
            resolvers.get(id)?.resolve(payload);
            resolvers.delete(id);
        } else if (type === MessageContext.llmError) {
            resolvers.get(id)?.reject(new Error(payload));
            resolvers.delete(id);
        } else if (type === MessageContext.startLoop) {
            try {
                await memory.init();
                const answer = await agentExecutor.invoke({
                    userPrompt: payload.userPrompt,
                    sessionId: payload.sessionId,
                    memory,
                    askLLM,
                    logToMain
                });
                const finalStr = typeof answer === "string" ? answer : answer?.finalAnswer || JSON.stringify(answer);
                self.postMessage({ id, type: MessageContext.agentComplete, payload: finalStr });
            } catch (err) {
                self.postMessage({ id, type: MessageContext.agentError, payload: err.message });
            }
        }
    });
}
