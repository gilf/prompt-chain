import { MessageContext, CallbackEvents } from "../consts.js";
import { AgentMemory } from "./agent-memory.js";
import { PromptTemplate } from "./prompt-template.js";
import { ToolRetriever } from "../tools/index.js";
import { SkillRetriever } from "../skills/index.js";
import { isRecoverableError, runWithTimeout, delay, compressHistory, pruneObservation } from "../utils.js";
import { Runnable, RunnableSequence, RunnableParallel, RunnableLambda, RunnablePassthrough, RunnableBinding, RunnableTokenBuffer, RunnableInterrupt, InterruptException, RunnableFallback, StructuredOutputRunnable, validateJSONSchema, StateGraph, CompiledStateGraph, START, END, AgentSupervisor, createAgentSupervisor } from "../runnables/index.js";
import { BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage } from "./messages.js";
import { CallbackManager } from "./callbacks.js";
import { SpanStatus, Span, Trace, Tracer, SpanExporter, ConsoleTraceExporter, IndexedDBTraceExporter, OTLPTraceExporter } from "../observability/index.js";

export { Runnable, RunnableSequence, RunnableParallel, RunnableLambda, RunnablePassthrough, RunnableBinding, RunnableTokenBuffer, RunnableInterrupt, InterruptException, RunnableFallback, StructuredOutputRunnable, validateJSONSchema, StateGraph, CompiledStateGraph, START, END, AgentSupervisor, createAgentSupervisor };
export { BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage };
export { CallbackManager };
export { SpanStatus, Span, Trace, Tracer, SpanExporter, ConsoleTraceExporter, IndexedDBTraceExporter, OTLPTraceExporter };


export class Tool extends Runnable {
    constructor(name, description, executeFn, schema = null, options = {}) {
        super();
        this.name = name;
        this.description = description;
        this.executeFn = executeFn;
        this.schema = schema;
        this.requiresApproval = Boolean(options.requiresApproval);
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

export class CloudFallbackLLMRunnable extends Runnable {
    constructor(options = {}) {
        super();
        this.apiUrl = options.apiUrl || "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";
        this.apiKey = options.apiKey || null;
        this.headers = options.headers || { "Content-Type": "application/json" };
        this.requestBuilder = options.requestBuilder || ((prompt) => ({
            contents: [{ parts: [{ text: typeof prompt === "string" ? prompt : JSON.stringify(prompt) }] }]
        }));
        this.responseParser = options.responseParser || ((data) => data?.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(data));
        this.logToMain = options.logToMain || (() => {});
    }

    async invoke(prompt, config = {}) {
        this.logToMain("☁️ CloudFallback: Executing remote fallback inference...");
        if (!this.apiUrl) {
            throw new Error("CloudFallbackLLMRunnable requires a valid apiUrl.");
        }
        const url = this.apiKey ? `${this.apiUrl}?key=${this.apiKey}` : this.apiUrl;
        const body = JSON.stringify(this.requestBuilder(prompt));

        const response = await fetch(url, {
            method: "POST",
            headers: this.headers,
            body
        });
        if (!response.ok) {
            throw new Error(`Cloud API Error: HTTP status ${response.status}`);
        }
        const data = await response.json();
        return this.responseParser(data);
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
    constructor({ tools = [], skills = [], memory, toolRetriever, skillRetriever, promptTemplate, inferenceStepChain, askLLM, logToMain, callbackManager, measureContextUsage = null, getContextStats = null, thresholdRatio = 0.85, maxIterations = 7, maxRetries = 3, retryDelayMs = 1000, defaultMaxTokens = 3400, maxSelfCorrectionAttempts = 2, cloudFallbackRunnable = null }) {
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
        this.maxSelfCorrectionAttempts = maxSelfCorrectionAttempts;
        this.cloudFallbackRunnable = cloudFallbackRunnable;
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

    async _invokeStepWithFallback(chainInput, selfCorrectionCount) {
        let stepResult = await this.inferenceStepChain.invoke(chainInput);
        if (!stepResult.success) {
            const nextCount = selfCorrectionCount + 1;
            if (nextCount >= this.maxSelfCorrectionAttempts && this.cloudFallbackRunnable) {
                this.logToMain(`⚠️ Local model failed self-correction ${nextCount} times. Routing to Fallback...`);
                this.callbackManager?.dispatch(CallbackEvents.fallbackRoute, { reason: `Exceeded ${nextCount} self-correction attempts`, target: this.cloudFallbackRunnable.constructor?.name || "FallbackRunnable" });
                const fallbackRaw = await this.cloudFallbackRunnable.invoke(chainInput);
                const parsedFallback = await new JSONOutputParserRunnable().invoke(fallbackRaw);
                if (parsedFallback.success) {
                    return { success: true, stepResult: parsedFallback, nextChainInput: chainInput, selfCorrectionCount: 0 };
                }
                return { success: false, stepResult: parsedFallback, nextChainInput: `Observation: ${parsedFallback.error}`, selfCorrectionCount: nextCount };
            }
            return { success: false, stepResult, nextChainInput: `Observation: ${stepResult.error}`, selfCorrectionCount: nextCount };
        }
        return { success: true, stepResult, nextChainInput: chainInput, selfCorrectionCount: 0 };
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
        let selfCorrectionCount = 0;

        while (!isComplete && loopCount < this.maxIterations) {
            loopCount++;

            this.callbackManager?.dispatch(CallbackEvents.llmStart, { loopCount });
            const stepOutcome = await this._invokeStepWithFallback(chainInput, selfCorrectionCount);
            selfCorrectionCount = stepOutcome.selfCorrectionCount;

            if (!stepOutcome.success) {
                chainInput = stepOutcome.nextChainInput;
                continue;
            }

            const stepResult = stepOutcome.stepResult;
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
                const tool = toolsMap.get(lookupToolName);
                if (tool.requiresApproval) {
                    const checkpointId = `chk_${sessionId}_${Date.now()}`;
                    const safeChainInput = typeof chainInput === "object" && chainInput !== null ? { isInitialObject: true } : chainInput;
                    const checkpointData = {
                        sessionId,
                        userPrompt,
                        loopCount,
                        currentTurnLog,
                        chainInput: safeChainInput,
                        historyTurns: historyTurns.map(item => typeof item?.toJSON === "function" ? item.toJSON() : item),
                        conversationSummary,
                        pendingToolName: response.toolName,
                        pendingToolInput: response.toolInput
                    };
                    await this.memory.saveCheckpoint(checkpointId, checkpointData);
                    this.logToMain(`System: Execution interrupted. Human approval required for tool '${response.toolName}'.`);
                    this.callbackManager?.dispatch(CallbackEvents.userApprovalRequired, {
                        checkpointId,
                        sessionId,
                        toolName: response.toolName,
                        toolInput: response.toolInput
                    });
                    return { interrupted: true, checkpointId, toolName: response.toolName, toolInput: response.toolInput };
                }

                const inputLogStr = typeof response.toolInput === "object" ? JSON.stringify(response.toolInput) : response.toolInput;
                this.logToMain(`Action: Running ${response.toolName} with input ${inputLogStr}`);
                this.callbackManager?.dispatch(CallbackEvents.toolStart, { toolName: response.toolName, toolInput: response.toolInput });

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

    async resume({ checkpointId, approvedParams, memory, askLLM, logToMain }) {
        if (memory) this.memory = memory;
        if (askLLM) this.askLLM = askLLM;
        if (logToMain) this.logToMain = logToMain;

        const checkpoint = await this.memory.getCheckpoint(checkpointId);
        if (!checkpoint) {
            throw new Error(`Checkpoint '${checkpointId}' not found.`);
        }

        const { sessionId, userPrompt } = checkpoint;
        let loopCount = checkpoint.loopCount || 0;
        let currentTurnLog = checkpoint.currentTurnLog || "";
        let historyTurns = checkpoint.historyTurns || [];
        let conversationSummary = checkpoint.conversationSummary || "";
        let chainInput = checkpoint.chainInput;
        const pendingToolName = checkpoint.pendingToolName;
        const toolInput = approvedParams ?? checkpoint.pendingToolInput;

        const { relevantTools, skillInstructions, toolsMap } = await this._prepareContext(userPrompt);
        if (typeof chainInput === "object" && chainInput !== null && chainInput.isInitialObject) {
            chainInput = { relevantTools, historyTurns, userPrompt, summary: conversationSummary, skillInstructions };
        }

        const lookupToolName = (pendingToolName || "").toLowerCase();
        if (toolsMap.has(lookupToolName)) {
            const tool = toolsMap.get(lookupToolName);
            const inputLogStr = typeof toolInput === "object" ? JSON.stringify(toolInput) : toolInput;
            this.logToMain(`Action: Resuming ${pendingToolName} with approved input ${inputLogStr}`);
            this.callbackManager?.dispatch(CallbackEvents.toolStart, { toolName: pendingToolName, toolInput });

            const execResult = await this._executeToolWithRetry(tool, pendingToolName, toolInput, inputLogStr);
            currentTurnLog += execResult.logStr;
            if (execResult.success) {
                this.callbackManager?.dispatch(CallbackEvents.toolEnd, { toolName: pendingToolName, toolResult: execResult.toolResult });
            }
            chainInput = execResult.nextObservation;
        }

        await this.memory.deleteCheckpoint(checkpointId);

        let isComplete = false;
        let finalResult = "";
        let selfCorrectionCount = 0;

        while (!isComplete && loopCount < this.maxIterations) {
            loopCount++;

            this.callbackManager?.dispatch(CallbackEvents.llmStart, { loopCount });
            const stepOutcome = await this._invokeStepWithFallback(chainInput, selfCorrectionCount);
            selfCorrectionCount = stepOutcome.selfCorrectionCount;

            if (!stepOutcome.success) {
                chainInput = stepOutcome.nextChainInput;
                continue;
            }

            const stepResult = stepOutcome.stepResult;
            const response = stepResult.parsed;

            if (response.thought) {
                this.logToMain(`Thought: ${response.thought}`);
                currentTurnLog += `Thought: ${response.thought}\n`;
            }

            const nextLookupToolName = (response.toolName || "").toLowerCase();

            if (response.finalAnswer && response.finalAnswer.trim() !== "") {
                finalResult = response.finalAnswer;
                currentTurnLog += `Assistant: ${response.finalAnswer}\n`;
                isComplete = true;
            }
            else if (nextLookupToolName && nextLookupToolName !== "none" && toolsMap.has(nextLookupToolName)) {
                const tool = toolsMap.get(nextLookupToolName);
                if (tool.requiresApproval) {
                    const newCheckpointId = `chk_${sessionId}_${Date.now()}`;
                    const safeChainInput = typeof chainInput === "object" && chainInput !== null ? { isInitialObject: true } : chainInput;
                    const checkpointData = {
                        sessionId,
                        userPrompt,
                        loopCount,
                        currentTurnLog,
                        chainInput: safeChainInput,
                        historyTurns: historyTurns.map(item => typeof item?.toJSON === "function" ? item.toJSON() : item),
                        conversationSummary,
                        pendingToolName: response.toolName,
                        pendingToolInput: response.toolInput
                    };
                    await this.memory.saveCheckpoint(newCheckpointId, checkpointData);
                    this.logToMain(`System: Execution interrupted. Human approval required for tool '${response.toolName}'.`);
                    this.callbackManager?.dispatch(CallbackEvents.userApprovalRequired, {
                        checkpointId: newCheckpointId,
                        sessionId,
                        toolName: response.toolName,
                        toolInput: response.toolInput
                    });
                    return { interrupted: true, checkpointId: newCheckpointId, toolName: response.toolName, toolInput: response.toolInput };
                }

                const inputLogStr = typeof response.toolInput === "object" ? JSON.stringify(response.toolInput) : response.toolInput;
                this.logToMain(`Action: Running ${response.toolName} with input ${inputLogStr}`);
                this.callbackManager?.dispatch(CallbackEvents.toolStart, { toolName: response.toolName, toolInput: response.toolInput });

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
    const cloudFallbackRunnable = new CloudFallbackLLMRunnable({
        apiUrl: options?.fallbackOptions?.apiUrl,
        apiKey: options?.fallbackOptions?.apiKey,
        mockFallback: options?.fallbackOptions?.mockFallback ?? true,
        logToMain,
        schema: agentSchema
    });
    const fallbackLLMRunnable = new RunnableFallback([
        bufferedLLMRunnable,
        cloudFallbackRunnable
    ], {
        onFallback: (err) => {
            logToMain(`⚠️ Local inference unavailable or failed (${err.message}). Routing to Cloud Fallback...`);
            callbackManager?.dispatch(CallbackEvents.fallbackRoute, { reason: err.message, target: "CloudFallback" });
        }
    });
    const parserRunnable = new JSONOutputParserRunnable();
    const structuredOutputRunnable = new StructuredOutputRunnable(fallbackLLMRunnable, agentSchema, { parser: parserRunnable });
    
    const inferenceStepChain = RunnableSequence.from([
        new RunnableLambda(async (promptInput) => {
            if (typeof promptInput === "string") return promptInput;
            return await promptTemplate.invoke(promptInput);
        }),
        structuredOutputRunnable
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
        defaultMaxTokens: options?.defaultMaxTokens,
        maxSelfCorrectionAttempts: options?.maxSelfCorrectionAttempts ?? 2,
        cloudFallbackRunnable
    });
}

export function createAgentWorker(toolsOrRunnable, skillsArray = [], callbacks = null, options = {}) {
    const callbackManager = callbacks instanceof CallbackManager ? callbacks : new CallbackManager();
    if (!callbackManager.tracer) {
        const tracer = new Tracer("WorkerTracer");
        tracer.addExporter(new IndexedDBTraceExporter());
        tracer.addExporter(new ConsoleTraceExporter());
        callbackManager.attachTracer(tracer);
    }
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
                if (answer && typeof answer === "object" && answer.interrupted) {
                    self.postMessage({ id, type: MessageContext.agentInterrupt, payload: answer });
                } else {
                    const finalStr = typeof answer === "string" ? answer : answer?.finalAnswer || JSON.stringify(answer);
                    self.postMessage({ id, type: MessageContext.agentComplete, payload: finalStr });
                }
            } catch (err) {
                self.postMessage({ id, type: MessageContext.agentError, payload: err.message });
            }
        } else if (type === MessageContext.resumeLoop) {
            try {
                await memory.init();
                const answer = await agentExecutor.resume({
                    checkpointId: payload.checkpointId,
                    approvedParams: payload.approvedParams,
                    memory,
                    askLLM,
                    logToMain
                });
                if (answer && typeof answer === "object" && answer.interrupted) {
                    self.postMessage({ id, type: MessageContext.agentInterrupt, payload: answer });
                } else {
                    const finalStr = typeof answer === "string" ? answer : answer?.finalAnswer || JSON.stringify(answer);
                    self.postMessage({ id, type: MessageContext.agentComplete, payload: finalStr });
                }
            } catch (err) {
                self.postMessage({ id, type: MessageContext.agentError, payload: err.message });
            }
        }
    });
}
