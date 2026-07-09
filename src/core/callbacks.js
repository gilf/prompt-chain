import { MessageContext, CallbackEvents } from "../consts.js";
import { SpanStatus } from "../observability/trace.js";

export class CallbackManager {
    constructor(handlers = {}) {
        this.handlers = new Map();
        this.tracer = null;
        for (const [event, fn] of Object.entries(handlers)) {
            this.addHandler(event, fn);
        }
    }

    attachTracer(tracer) {
        this.tracer = tracer;
        if (this.tracer && !this.tracer.onTraceComplete) {
            this.tracer.onTraceComplete = (completedTrace) => {
                this.dispatch(CallbackEvents.traceComplete || "on_trace_complete", completedTrace.toJSON());
            };
        }
        return this;
    }

    addHandler(event, fn) {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, []);
        }
        this.handlers.get(event).push(fn);
    }

    removeHandler(event, fn) {
        if (this.handlers.has(event)) {
            const list = this.handlers.get(event).filter(h => h !== fn);
            this.handlers.set(event, list);
        }
    }

    dispatch(event, payload = {}) {
        if (this.handlers.has(event)) {
            for (const handler of this.handlers.get(event)) {
                try {
                    handler(payload);
                } catch (err) {
                    console.error(`Error in callback handler for event '${event}':`, err);
                }
            }
        }

        if (this.tracer) {
            try {
                if (event === CallbackEvents.chainStart || event === CallbackEvents.graphStart || event === "on_chain_start" || event === "on_graph_start") {
                    if (!this.tracer.activeTrace) {
                        this.tracer.startTrace(payload.name || "AgentExecution", payload);
                    }
                    this.tracer.startSpan(payload.name || event, "INTERNAL", payload);
                } else if (event === CallbackEvents.llmStart || event === "on_llm_start") {

                    this.tracer.startSpan("LLMInference", "CLIENT", payload);
                } else if (event === CallbackEvents.toolStart || event === "on_tool_start") {
                    this.tracer.startSpan(`Tool.${payload.toolName || "unknown"}`, "INTERNAL", payload);
                } else if (event === CallbackEvents.nodeStart || event === "on_node_start") {
                    this.tracer.startSpan(`Node.${payload.node || "unknown"}`, "INTERNAL", payload);
                } else if (
                    event === CallbackEvents.chainEnd || event === CallbackEvents.graphEnd ||
                    event === CallbackEvents.llmEnd || event === CallbackEvents.toolEnd ||
                    event === CallbackEvents.nodeEnd || event === "on_chain_end" ||
                    event === "on_graph_end" || event === "on_llm_end" ||
                    event === "on_tool_end" || event === "on_node_end"
                ) {
                    this.tracer.endCurrentSpan({ code: SpanStatus.OK }, payload);
                } else if (event === CallbackEvents.toolError || event === "on_tool_error" || event === "agent_error" || event === "llm_error") {
                    this.tracer.endCurrentSpan({ code: SpanStatus.ERROR, message: payload.error || payload.message || "Error" }, payload);
                } else if (
                    event === CallbackEvents.llmNewToken || event === CallbackEvents.supervisorRoute ||
                    event === CallbackEvents.fallbackRoute || event === CallbackEvents.contextOverflow ||
                    event === "on_llm_new_token" || event === "on_supervisor_route" ||
                    event === "on_fallback_route" || event === "on_context_overflow"
                ) {
                    this.tracer.addEvent(event, payload);
                }
            } catch (err) {
                console.error("Error in Tracer callback bridge:", err);
            }
        }

        if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
            self.postMessage({
                id: 0,
                type: MessageContext.agentCallbackEvent,
                payload: { event, ...payload }
            });
            if (event === CallbackEvents.traceComplete || event === "on_trace_complete") {
                self.postMessage({
                    id: 0,
                    type: MessageContext.agentTraceComplete,
                    payload: payload
                });
            }
        }
    }
}

