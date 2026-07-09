import { Trace, SpanStatus } from './trace.js';

export class Tracer {
    constructor(name = "DefaultTracer") {
        this.name = name;
        this.activeTrace = null;
        this.activeSpanStack = [];
        this.exporters = [];
    }

    addExporter(exporter) {
        if (exporter && typeof exporter.export === "function") {
            this.exporters.push(exporter);
        }
        return this;
    }

    startTrace(name = "TraceExecution", attributes = {}) {
        this.activeTrace = new Trace({ name, attributes });
        this.activeSpanStack = [];
        return this.activeTrace;
    }

    startSpan(name, kind = "INTERNAL", attributes = {}) {
        if (!this.activeTrace) {
            this.startTrace(name, attributes);
        }
        const parentSpanId = this.activeSpanStack.length > 0 ? this.activeSpanStack[this.activeSpanStack.length - 1] : null;
        const span = this.activeTrace.startSpan(name, { parentSpanId, kind, attributes });
        this.activeSpanStack.push(span.spanId);
        return span;
    }

    endCurrentSpan(status = { code: SpanStatus.OK }, attributes = {}) {
        if (!this.activeTrace || this.activeSpanStack.length === 0) return null;
        const spanId = this.activeSpanStack.pop();
        const span = this.activeTrace.endSpan(spanId, status, attributes);
        let completedTrace = null;

        if (this.activeSpanStack.length === 0 && span && span.spanId === this.activeTrace.rootSpanId) {
            completedTrace = this.activeTrace;
            if (!completedTrace.endTime) {
                completedTrace.endTime = Date.now();
                completedTrace.durationMs = completedTrace.endTime - completedTrace.startTime;
            }
            this.exportTrace(completedTrace);
            this.activeTrace = null;
            if (typeof this.onTraceComplete === "function") {
                try { this.onTraceComplete(completedTrace); } catch(e) {}
            }
        }
        return { span, trace: completedTrace };
    }

    addEvent(eventName, attributes = {}) {
        if (!this.activeTrace || this.activeSpanStack.length === 0) return null;
        const currentSpanId = this.activeSpanStack[this.activeSpanStack.length - 1];
        return this.activeTrace.addEventToSpan(currentSpanId, eventName, attributes);
    }

    async exportTrace(trace) {
        for (const exporter of this.exporters) {
            try {
                await exporter.export(trace);
            } catch (err) {
                console.error(`Error in exporter '${exporter.constructor?.name}':`, err);
            }
        }
    }
}
