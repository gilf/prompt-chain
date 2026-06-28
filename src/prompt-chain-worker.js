import { MessageContext, CallbackEvents } from "./consts.js";
import { AgentMemory } from "./agent-memory.js";
import { PromptTemplate } from "./prompt-template.js";
import { ToolRetriever } from "./tool-retriever.js";
import { SkillRetriever } from "./skill-retriever.js";
import { isRecoverableError, runWithTimeout, delay, compressHistory, pruneObservation } from "./utils.js";
import { Runnable, RunnableSequence, RunnableParallel, RunnableLambda, RunnablePassthrough, RunnableBinding, RunnableTokenBuffer } from "./runnable.js";
import { BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage } from "./messages.js";
import { CallbackManager } from "./callbacks.js";

export { Runnable, RunnableSequence, RunnableParallel, RunnableLambda, RunnablePassthrough, RunnableBinding, RunnableTokenBuffer };
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
    constructor({ tools = [], skills = [], memory, toolRetriever, skillRetriever, promptTemplate, inferenceStepChain, askLLM, logToMain, callbackManager, measureContextUsage = null, getContextStats = null, thresholdRatio = 0.85, maxIterations = 7, maxRetries = 3, retryDelayMs = 1000, defaultMaxTokens = 3400 }) {
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
        this.measureContextUsage = measureContextUsage;
        this.getContextStats = getContextStats;
        this.thresholdRatio = thresholdRatio;
        this.maxIterations = maxIterations;
        this.maxRetries = maxRetries;
        this.retryDelayMs = retryDelayMs;
        this.defaultMaxTokens = defaultMaxTokens;
    }

    async _prepareContext(userPrompt) {
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
        return { relevantTools, skillInstructions, toolsMap };
    }

    async _executeToolWithRetry(tool, toolName, toolInput, inputLogStr) {
        let toolResult;
        let success = false;
        let retryCount = 0;

        while (retryCount <= this.maxRetries && !success) {
            try {
                toolResult = await tool.invoke(toolInput);
                success = true;
            } catch (err) {
                if (isRecoverableError(err) && retryCount < this.maxRetries) {
                    retryCount++;
                    this.logToMain(`Observation: Tool timed out. Retrying...`);
                    await delay(this.retryDelayMs);
                } else {
                    const logStr = `Action: ${toolName}(${inputLogStr})\nObservation: Tool failed with error: ${err.message}\n`;
                    this.logToMain(`Observation: Tool failed with error: ${err.message}`);
                    return {
                        success: false,
                        logStr,
                        nextObservation: `Observation: Tool '${toolName}' failed because: ${err.message}. Please correct the input/parameters, try a different approach, or check tool availability, and try again.`
                    };
                }
            }
        }

        const logStr = `Action: ${toolName}(${inputLogStr})\nObservation: ${toolResult}\n`;
        this.logToMain(`Observation: ${toolResult}`);
        return {
            success: true,
            toolResult,
            logStr,
            nextObservation: `Observation from ${toolName}: ${toolResult}\nGiven this observation, output your next step as JSON:`
        };
    }

    async _saveAndCompressHistory(sessionId, userPrompt, finalResult, historyTurns, conversationSummary) {
        historyTurns.push(new HumanMessage(userPrompt));
        historyTurns.push(new AIMessage(finalResult));
        let maxTokens = this.defaultMaxTokens;
        if (typeof this.getContextStats === 'function') {
            try {
                const stats = await this.getContextStats();
                if (stats && stats.window) maxTokens = Math.floor(stats.window * this.thresholdRatio);
            } catch (e) {}
        }
        const compressionResult = await compressHistory(historyTurns, conversationSummary, this.askLLM, this.logToMain, { measureTokensFn: this.measureContextUsage, maxTokens, threshold: 5, recency: 2 });
        await this.memory.saveHistory(sessionId, compressionResult.historyTurns, compressionResult.updatedSummary);
    }

    async invoke({ userPrompt, sessionId }) {
        this.callbackManager?.dispatch(CallbackEvents.chainStart, { userPrompt, sessionId });

        let isComplete = false;
        let finalResult = "";
        let loopCount = 0;

        let { history: historyTurns, summary: conversationSummary } = await this.memory.getHistory(sessionId);
        const { relevantTools, skillInstructions, toolsMap } = await this._prepareContext(userPrompt);

        let currentTurnLog = `User: ${userPrompt}\n`;
        let chainInput = { relevantTools, historyTurns, userPrompt, summary: conversationSummary, skillInstructions };

        while (!isComplete && loopCount < this.maxIterations) {
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
                const execResult = await this._executeToolWithRetry(tool, response.toolName, response.toolInput, inputLogStr);
                currentTurnLog += execResult.logStr;
                if (execResult.success) {
                    this.callbackManager?.dispatch(CallbackEvents.toolEnd, { toolName: response.toolName, toolResult: execResult.toolResult });
                }
                chainInput = execResult.nextObservation;
            }
            else if (response.toolName === "none" || response.toolName === "") {
                chainInput = `Observation: You set toolName to "none" but omitted a finalAnswer. Provide your final answer text in the JSON.`;
            }
            else {
                chainInput = `Observation: Tool '${response.toolName}' is not loaded. Select from available tools or use 'none'.`;
            }
        }

        if (finalResult) {
            await this._saveAndCompressHistory(sessionId, userPrompt, finalResult, historyTurns, conversationSummary);
        }

        const finalOutput = finalResult || "Error: Reached maximum iterations.";
        this.callbackManager?.dispatch(CallbackEvents.chainEnd, { finalOutput });
        return finalOutput;
    }
}

export class WorkerRPCClient {
    constructor() {
        this.msgId = 0;
        this.resolvers = new Map();
    }

    request(type, payload) {
        return new Promise((resolve, reject) => {
            const id = ++this.msgId;
            this.resolvers.set(id, { resolve, reject });
            self.postMessage({ id, type, payload });
        });
    }

    handleResponse(id, payload, isError = false) {
        const resolver = this.resolvers.get(id);
        if (resolver) {
            if (isError) {
                resolver.reject(new Error(payload));
            } else {
                resolver.resolve(payload);
            }
            this.resolvers.delete(id);
        }
    }

    logToMain(message) {
        self.postMessage({ id: 0, type: MessageContext.agentLog, payload: message });
    }
}

export function createDefaultAgentExecutor(toolsArray, skillsArray, askLLM, measureContextUsage, getContextStats, logToMain, callbackManager, memory, options, agentSchema) {
    const toolRetriever = new ToolRetriever(toolsArray);
    const skillRetriever = new SkillRetriever(skillsArray);
    const promptTemplate = new PromptTemplate();
    
    const llmRunnable = new LLMRunnable(askLLM, agentSchema);
    const bufferedLLMRunnable = new RunnableTokenBuffer({
        boundRunnable: llmRunnable,
        measureTokensFn: measureContextUsage,
        getStatsFn: getContextStats,
        thresholdRatio: options?.thresholdRatio ?? 0.85,
        pruneObservationFn: pruneObservation
    });
    const parserRunnable = new JSONOutputParserRunnable();
    
    const inferenceStepChain = RunnableSequence.from([
        new RunnableLambda(async (promptInput) => {
            if (typeof promptInput === "string") return promptInput;
            return await promptTemplate.invoke(promptInput);
        }),
        bufferedLLMRunnable,
        parserRunnable
    ]);

    return new ReActAgentExecutor({
        tools: toolsArray,
        skills: skillsArray,
        memory,
        toolRetriever,
        skillRetriever,
        promptTemplate,
        inferenceStepChain,
        askLLM,
        logToMain,
        callbackManager,
        measureContextUsage,
        getContextStats,
        thresholdRatio: options?.thresholdRatio ?? 0.85,
        maxIterations: options?.maxIterations,
        maxRetries: options?.maxRetries,
        retryDelayMs: options?.retryDelayMs,
        defaultMaxTokens: options?.defaultMaxTokens
    });
}

export function createAgentWorker(toolsOrRunnable, skillsArray = [], callbacks = null, options = {}) {
    const callbackManager = callbacks instanceof CallbackManager ? callbacks : new CallbackManager();
    const memory = new AgentMemory();
    const rpcClient = new WorkerRPCClient();

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

    const askLLM = (prompt, schema = agentSchema) => rpcClient.request(MessageContext.llmRequest, { prompt, schema });
    const measureContextUsage = (input) => rpcClient.request(MessageContext.llmMeasureContext, { input });
    const getContextStats = () => rpcClient.request(MessageContext.llmContextStats, {});
    const logToMain = (msg) => rpcClient.logToMain(msg);

    let agentExecutor;
    if (toolsOrRunnable instanceof Runnable || typeof toolsOrRunnable?.invoke === "function") {
        agentExecutor = toolsOrRunnable;
    } else {
        const toolsArray = Array.isArray(toolsOrRunnable) ? toolsOrRunnable : [];
        agentExecutor = createDefaultAgentExecutor(toolsArray, skillsArray, askLLM, measureContextUsage, getContextStats, logToMain, callbackManager, memory, options, agentSchema);
    }

    self.addEventListener('message', async (e) => {
        const { id, type, payload } = e.data;

        if (type === MessageContext.llmStreamToken) {
            callbackManager.dispatch(CallbackEvents.llmNewToken, { token: payload });
        } else if (type === MessageContext.llmMeasureResponse || type === MessageContext.llmStatsResponse || type === MessageContext.llmResponse) {
            if (type === MessageContext.llmResponse) {
                callbackManager.dispatch(CallbackEvents.llmEnd, { response: payload });
            }
            rpcClient.handleResponse(id, payload);
        } else if (type === MessageContext.llmError) {
            rpcClient.handleResponse(id, payload, true);
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
