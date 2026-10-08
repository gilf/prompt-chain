import { Runnable } from "../runnables/runnable.js";
import { HumanMessage, AIMessage } from "./messages.js";
import { CallbackEvents } from "../consts.js";
import { isRecoverableError, delay, compressHistory } from "../utils.js";
import { JSONOutputParserRunnable } from "../runnables/json-output-parser-runnable.js";

/**
 * Enterprise ReAct (Reasoning + Acting) Agent Executor.
 * Manages the multi-turn agent reasoning loop, tool selection/execution with retries,
 * JSON Schema self-correction, HITL interruptions/checkpointing, and fallback routing.
 *
 * @extends Runnable
 */
export class ReActAgentExecutor extends Runnable {
    /**
     * @param {Object} options - Configuration options for the executor.
     * @param {Array<import('../tools/tool.js').Tool>} [options.tools=[]] - Tool instances available to the agent.
     * @param {Array} [options.skills=[]] - Skill definitions.
     * @param {import('./agent-memory.js').AgentMemory} options.memory - Memory persistence controller.
     * @param {import('../tools/tool-retriever.js').ToolRetriever} options.toolRetriever - Retriever for dynamic tool pruning.
     * @param {import('../skills/skill-retriever.js').SkillRetriever} options.skillRetriever - Retriever for skill instructions.
     * @param {import('./prompt-template.js').PromptTemplate} options.promptTemplate - Prompt renderer.
     * @param {import('../runnables/runnable.js').Runnable} options.inferenceStepChain - LCEL chain executing single ReAct steps.
     * @param {Function} options.askLLM - Execution function for LLM prompts.
     * @param {Function} options.logToMain - Logger callback.
     * @param {import('./callbacks.js').CallbackManager} [options.callbackManager] - Event & trace manager.
     * @param {Function|null} [options.measureContextUsage=null] - Context window measurement function.
     * @param {Function|null} [options.getContextStats=null] - Context statistics getter function.
     * @param {number} [options.thresholdRatio=0.85] - Watermark threshold for context window.
     * @param {number} [options.maxIterations=7] - Maximum ReAct reasoning turns allowed per prompt.
     * @param {number} [options.maxRetries=3] - Maximum tool execution retries on recoverable failure.
     * @param {number} [options.retryDelayMs=1000] - Delay in milliseconds between tool retries.
     * @param {number} [options.defaultMaxTokens=3400] - Token budget default for memory pruning.
     * @param {number} [options.maxSelfCorrectionAttempts=2] - Max JSON Schema self-correction turns before routing to fallback.
     * @param {import('../runnables/runnable.js').Runnable|null} [options.cloudFallbackRunnable=null] - Cloud fallback runnable.
     */
    constructor({
        tools = [],
        skills = [],
        memory,
        toolRetriever,
        skillRetriever,
        promptTemplate,
        inferenceStepChain,
        askLLM,
        logToMain,
        callbackManager,
        measureContextUsage = null,
        getContextStats = null,
        thresholdRatio = 0.85,
        maxIterations = 7,
        maxRetries = 3,
        retryDelayMs = 1000,
        defaultMaxTokens = 3400,
        maxSelfCorrectionAttempts = 2,
        cloudFallbackRunnable = null,
        abortSignal = null
    }) {
        super();
        this.abortSignal = abortSignal;
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
        if (this.abortSignal?.aborted) {
            throw this.abortSignal.reason || new Error("Tool execution aborted.");
        }
        let toolResult;
        let success = false;
        let retryCount = 0;

        while (retryCount <= this.maxRetries && !success) {
            if (this.abortSignal?.aborted) {
                throw this.abortSignal.reason || new Error("Tool execution aborted.");
            }
            try {
                toolResult = await tool.invoke(toolInput, { signal: this.abortSignal, timeoutMs: this.retryDelayMs * 3 || 3000 });
                success = true;
            } catch (err) {
                if (this.abortSignal?.aborted) {
                    throw this.abortSignal.reason || new Error("Tool execution aborted.");
                }
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

    /**
     * Shared core ReAct reasoning turn loop used by both invoke() and resume().
     * @private
     */
    async _runReActLoop({ chainInput, historyTurns, userPrompt, sessionId, loopCount, currentTurnLog, conversationSummary, toolsMap }) {
        let isComplete = false;
        let finalResult = "";
        let selfCorrectionCount = 0;

        while (!isComplete && loopCount < this.maxIterations) {
            if (this.abortSignal?.aborted) {
                throw this.abortSignal.reason || new Error("Agent execution aborted.");
            }
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

    /**
     * Executes the ReAct reasoning agent loop for a user prompt.
     * @param {Object} payload - Agent execution options.
     * @param {string} payload.userPrompt - User query or directive.
     * @param {string} [payload.sessionId="default_session"] - Conversation session ID.
     * @returns {Promise<string|Object>} Final text answer or interruption checkpoint state.
     */
    async invoke({ userPrompt, sessionId, signal }) {
        if (signal) this.abortSignal = signal;
        if (this.abortSignal?.aborted) {
            throw this.abortSignal.reason || new Error("Agent execution aborted.");
        }
        this.callbackManager?.dispatch(CallbackEvents.chainStart, { userPrompt, sessionId });

        let { history: historyTurns, summary: conversationSummary } = await this.memory.getHistory(sessionId);
        const { relevantTools, skillInstructions, toolsMap } = await this._prepareContext(userPrompt);

        let currentTurnLog = `User: ${userPrompt}\n`;
        let chainInput = { relevantTools, historyTurns, userPrompt, summary: conversationSummary, skillInstructions };

        return await this._runReActLoop({
            chainInput,
            historyTurns,
            userPrompt,
            sessionId,
            loopCount: 0,
            currentTurnLog,
            conversationSummary,
            toolsMap
        });
    }

    /**
     * Resumes an interrupted ReAct agent execution following human approval/rejection of a sensitive tool call.
     * @param {Object} options - Resumption options.
     * @param {string} options.checkpointId - Checkpoint identifier.
     * @param {Object} [options.approvedParams] - Optional user-approved/modified tool parameters.
     * @param {import('./agent-memory.js').AgentMemory} [options.memory] - Optional memory instance.
     * @param {Function} [options.askLLM] - Optional askLLM handler.
     * @param {Function} [options.logToMain] - Optional logger callback.
     * @param {AbortSignal} [options.signal] - Optional abort signal.
     * @returns {Promise<string|Object>} Final answer string or next interruption checkpoint.
     */
    async resume({ checkpointId, approvedParams, memory, askLLM, logToMain, signal }) {
        if (signal) this.abortSignal = signal;
        if (this.abortSignal?.aborted) {
            throw this.abortSignal.reason || new Error("Agent execution aborted.");
        }
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

        return await this._runReActLoop({
            chainInput,
            historyTurns,
            userPrompt,
            sessionId,
            loopCount,
            currentTurnLog,
            conversationSummary,
            toolsMap
        });
    }
}
