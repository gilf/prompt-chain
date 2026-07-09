export const SpanStatus = {
    OK: "OK",
    ERROR: "ERROR",
    UNSET: "UNSET"
};

export function generateHexId(length = 16) {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(Math.ceil(length / 2));
        crypto.getRandomValues(bytes);
        return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
    }
    let result = '';
    for (let i = 0; i < length; i++) {
        result += Math.floor(Math.random() * 16).toString(16);
    }
    return result;
}

export class Span {
    constructor({ traceId, spanId = null, parentSpanId = null, name = "UnnamedSpan", kind = "INTERNAL", attributes = {}, startTime = null } = {}) {
        this.traceId = traceId || generateHexId(32);
        this.spanId = spanId || generateHexId(16);
        this.parentSpanId = parentSpanId || null;
        this.name = name;
        this.kind = kind; // INTERNAL, CLIENT, SERVER, PRODUCER, CONSUMER
        this.startTime = startTime || Date.now();
        this.endTime = null;
        this.durationMs = null;
        this.status = { code: SpanStatus.UNSET, message: "" };
        this.attributes = Object.assign({}, attributes);
        this.events = [];
    }

    end(status = { code: SpanStatus.OK }, attributes = {}) {
        this.endTime = Date.now();
        this.durationMs = this.endTime - this.startTime;
        if (status && status.code) {
            this.status = Object.assign({}, this.status, status);
        }
        if (attributes && typeof attributes === "object") {
            Object.assign(this.attributes, attributes);
        }
        return this;
    }

    addEvent(name, attributes = {}) {
        this.events.push({
            name,
            timestamp: Date.now(),
            attributes: Object.assign({}, attributes)
        });
        return this;
    }

    toJSON() {
        return {
            traceId: this.traceId,
            spanId: this.spanId,
            parentSpanId: this.parentSpanId,
            name: this.name,
            kind: this.kind,
            startTime: this.startTime,
            endTime: this.endTime,
            durationMs: this.durationMs,
            status: this.status,
            attributes: this.attributes,
            events: this.events
        };
    }

    static fromJSON(data) {
        const span = new Span({
            traceId: data.traceId,
            spanId: data.spanId,
            parentSpanId: data.parentSpanId,
            name: data.name,
            kind: data.kind,
            attributes: data.attributes,
            startTime: data.startTime
        });
        span.endTime = data.endTime;
        span.durationMs = data.durationMs;
        span.status = data.status || { code: SpanStatus.UNSET, message: "" };
        span.events = data.events || [];
        return span;
    }

    toOTLP() {
        const kindMap = {
            "INTERNAL": 1,
            "SERVER": 2,
            "CLIENT": 3,
            "PRODUCER": 4,
            "CONSUMER": 5
        };
        const statusCodeMap = {
            "UNSET": 0,
            "OK": 1,
            "ERROR": 2
        };

        const formatAttributes = (attrs) => {
            const list = [];
            for (const [key, val] of Object.entries(attrs || {})) {
                if (val === undefined || val === null) continue;
                let valueObj;
                if (typeof val === "string") valueObj = { stringValue: val };
                else if (typeof val === "number") valueObj = { doubleValue: val };
                else if (typeof val === "boolean") valueObj = { boolValue: val };
                else valueObj = { stringValue: JSON.stringify(val) };
                list.push({ key, value: valueObj });
            }
            return list;
        };

        return {
            traceId: this.traceId,
            spanId: this.spanId,
            parentSpanId: this.parentSpanId || "",
            name: this.name,
            kind: kindMap[this.kind] || 1,
            startTimeUnixNano: String((this.startTime || 0) * 1000000),
            endTimeUnixNano: String((this.endTime || Date.now()) * 1000000),
            attributes: formatAttributes(this.attributes),
            events: (this.events || []).map(e => ({
                timeUnixNano: String((e.timestamp || 0) * 1000000),
                name: e.name,
                attributes: formatAttributes(e.attributes)
            })),
            status: {
                code: statusCodeMap[this.status?.code] || 0,
                message: this.status?.message || ""
            }
        };
    }
}

export class Trace {
    constructor({ traceId = null, name = "Trace", attributes = {} } = {}) {
        this.traceId = traceId || generateHexId(32);
        this.name = name;
        this.rootSpanId = null;
        this.startTime = Date.now();
        this.endTime = null;
        this.durationMs = null;
        this.spans = new Map();
        this.attributes = Object.assign({}, attributes);
        this.status = { code: SpanStatus.UNSET, message: "" };
    }

    startSpan(name, { parentSpanId = null, kind = "INTERNAL", attributes = {} } = {}) {
        const span = new Span({
            traceId: this.traceId,
            parentSpanId: parentSpanId || this.rootSpanId || null,
            name,
            kind,
            attributes
        });
        if (!this.rootSpanId && !parentSpanId) {
            this.rootSpanId = span.spanId;
        }
        this.spans.set(span.spanId, span);
        return span;
    }

    endSpan(spanId, status = { code: SpanStatus.OK }, attributes = {}) {
        const span = this.spans.get(spanId);
        if (!span) return null;
        span.end(status, attributes);
        
        if (span.status?.code === SpanStatus.ERROR) {
            this.status = { code: SpanStatus.ERROR, message: span.status.message || "Error in child span" };
        }

        if (span.spanId === this.rootSpanId) {
            this.endTime = span.endTime || Date.now();
            this.durationMs = this.endTime - this.startTime;
            if (this.status.code !== SpanStatus.ERROR) {
                this.status = { code: status?.code || SpanStatus.OK, message: status?.message || "" };
            }
        }
        return span;
    }

    addEventToSpan(spanId, eventName, attributes = {}) {
        const span = this.spans.get(spanId);
        if (span) {
            span.addEvent(eventName, attributes);
        }
        return span;
    }

    toJSON() {
        return {
            traceId: this.traceId,
            name: this.name,
            rootSpanId: this.rootSpanId,
            startTime: this.startTime,
            endTime: this.endTime,
            durationMs: this.durationMs,
            status: this.status,
            attributes: this.attributes,
            spans: Array.from(this.spans.values()).map(s => s.toJSON())
        };
    }

    static fromJSON(data) {
        const trace = new Trace({
            traceId: data.traceId,
            name: data.name,
            attributes: data.attributes
        });
        trace.rootSpanId = data.rootSpanId;
        trace.startTime = data.startTime;
        trace.endTime = data.endTime;
        trace.durationMs = data.durationMs;
        trace.status = data.status || { code: SpanStatus.UNSET, message: "" };
        if (Array.isArray(data.spans)) {
            for (const sData of data.spans) {
                const span = Span.fromJSON(sData);
                trace.spans.set(span.spanId, span);
            }
        }
        return trace;
    }

    toOTLP() {
        const spansList = Array.from(this.spans.values()).map(s => s.toOTLP());
        return {
            resourceSpans: [
                {
                    resource: {
                        attributes: [
                            { key: "service.name", value: { stringValue: "prompt-chain-agent" } },
                            { key: "trace.name", value: { stringValue: this.name } }
                        ]
                    },
                    scopeSpans: [
                        {
                            scope: {
                                name: "prompt-chain.observability",
                                version: "0.1.1"
                            },
                            spans: spansList
                        }
                    ]
                }
            ]
        };
    }
}
