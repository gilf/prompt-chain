import { MessageContext, CallbackEvents } from "../consts.js";
import { AgentMemory } from "./agent-memory.js";
import { PromptTemplate } from "./prompt-template.js";
import { Tool, ToolRetriever } from "../tools/index.js";
import { SkillRetriever } from "../skills/index.js";
import { pruneObservation } from "../utils.js";
import {
    Runnable,
    RunnableSequence,
    RunnableParallel,
    RunnableLambda,
    RunnablePassthrough,
    RunnableBinding,
    RunnableTokenBuffer,
    RunnableInterrupt,
    InterruptException,
    RunnableFallback,
    StructuredOutputRunnable,
    validateJSONSchema,
    StateGraph,
    CompiledStateGraph,
    START,
    END,
    AgentSupervisor,
    createAgentSupervisor,
    LLMRunnable,
    CloudFallbackLLMRunnable,
    JSONOutputParserRunnable
} from "../runnables/index.js";
import { BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage } from "./messages.js";
import { CallbackManager } from "./callbacks.js";
import { SpanStatus, Span, Trace, Tracer, SpanExporter, ConsoleTraceExporter, IndexedDBTraceExporter, OTLPTraceExporter } from "../observability/index.js";
import { ReActAgentExecutor } from "./react-agent-executor.js";

export { Tool };
export { LLMRunnable, CloudFallbackLLMRunnable, JSONOutputParserRunnable, ReActAgentExecutor };
export { Runnable, RunnableSequence, RunnableParallel, RunnableLambda, RunnablePassthrough, RunnableBinding, RunnableTokenBuffer, RunnableInterrupt, InterruptException, RunnableFallback, StructuredOutputRunnable, validateJSONSchema, StateGraph, CompiledStateGraph, START, END, AgentSupervisor, createAgentSupervisor };
export { BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage };
export { CallbackManager };
export { SpanStatus, Span, Trace, Tracer, SpanExporter, ConsoleTraceExporter, IndexedDBTraceExporter, OTLPTraceExporter };

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

    let currentAbortController = null;

    self.addEventListener('message', async (e) => {
        const { id, type, payload } = e.data;

        if (type === MessageContext.abortLoop) {
            if (currentAbortController) {
                currentAbortController.abort(new Error("Agent execution aborted by host."));
            }
        } else if (type === MessageContext.llmStreamToken) {
            callbackManager.dispatch(CallbackEvents.llmNewToken, { token: payload });
        } else if (type === MessageContext.llmMeasureResponse || type === MessageContext.llmStatsResponse || type === MessageContext.llmResponse) {
            if (type === MessageContext.llmResponse) {
                callbackManager.dispatch(CallbackEvents.llmEnd, { response: payload });
            }
            rpcClient.handleResponse(id, payload);
        } else if (type === MessageContext.llmError) {
            rpcClient.handleResponse(id, payload, true);
        } else if (type === MessageContext.startLoop) {
            currentAbortController = new AbortController();
            try {
                await memory.init();
                const answer = await agentExecutor.invoke({
                    userPrompt: payload.userPrompt,
                    sessionId: payload.sessionId,
                    signal: currentAbortController.signal,
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
            currentAbortController = new AbortController();
            try {
                await memory.init();
                const answer = await agentExecutor.resume({
                    checkpointId: payload.checkpointId,
                    approvedParams: payload.approvedParams,
                    signal: currentAbortController.signal,
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
