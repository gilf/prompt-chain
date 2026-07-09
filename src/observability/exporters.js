import { Trace } from './trace.js';
import { openIndexedDB } from '../utils.js';

export class SpanExporter {
    async export(trace) {
        throw new Error("SpanExporter.export() must be implemented.");
    }
}

export class ConsoleTraceExporter extends SpanExporter {
    async export(trace) {
        if (typeof console === 'undefined') return;
        const duration = trace.durationMs !== null ? `${trace.durationMs}ms` : 'in-progress';
        const status = trace.status?.code || 'UNSET';
        
        if (console.groupCollapsed) {
            console.groupCollapsed(`%c[Trace] ${trace.name} (${duration} - ${status}) [ID: ${trace.traceId}]`, 'color: #3b82f6; font-weight: bold;');
        } else {
            console.log(`[Trace] ${trace.name} (${duration} - ${status}) [ID: ${trace.traceId}]`);
        }

        const spans = Array.from(trace.spans.values());
        const rootSpans = spans.filter(s => !s.parentSpanId || !trace.spans.has(s.parentSpanId));
        
        const printSpan = (span, depth = 0) => {
            const indent = '  '.repeat(depth);
            const spanDur = span.durationMs !== null ? `${span.durationMs}ms` : 'in-progress';
            const spanStatus = span.status?.code || 'UNSET';
            const color = spanStatus === 'ERROR' ? '#ef4444' : '#10b981';
            console.log(`%c${indent}└─ [Span: ${span.name}] (${spanDur} - ${spanStatus}) [ID: ${span.spanId}]`, `color: ${color};`);
            
            if (Object.keys(span.attributes || {}).length > 0) {
                console.log(`${indent}    Attributes:`, span.attributes);
            }
            if ((span.events || []).length > 0) {
                console.log(`${indent}    Events (${span.events.length}):`, span.events);
            }

            const children = spans.filter(s => s.parentSpanId === span.spanId);
            for (const child of children) {
                printSpan(child, depth + 1);
            }
        };

        for (const root of rootSpans) {
            printSpan(root, 0);
        }

        if (console.groupEnd) {
            console.groupEnd();
        }
    }
}

export class IndexedDBTraceExporter extends SpanExporter {
    constructor(dbName = "AgentMemoryDB", storeName = "traces") {
        super();
        this.dbName = dbName;
        this.storeName = storeName;
        this.db = null;
    }

    async init() {
        if (!this.db) {
            this.db = await openIndexedDB(this.dbName, ["conversations", "checkpoints", "traces"]);
        }
        return this.db;
    }

    async export(trace) {
        if (typeof indexedDB === 'undefined') return;
        if (!this.db) {
            await this.init();
        }
        if (!this.db) return;

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, "readwrite");
            const store = tx.objectStore(this.storeName);
            const request = store.put(trace.toJSON());
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }

    async getTraces({ limit = 50 } = {}) {
        if (typeof indexedDB === 'undefined') return [];
        if (!this.db) {
            await this.init();
        }
        if (!this.db) return [];

        return new Promise((resolve) => {
            const tx = this.db.transaction(this.storeName, "readonly");
            const store = tx.objectStore(this.storeName);
            const request = store.getAll();

            request.onsuccess = () => {
                if (request.result) {
                    const list = request.result.map(d => Trace.fromJSON(d));
                    list.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
                    resolve(list.slice(0, limit));
                } else {
                    resolve([]);
                }
            };
            request.onerror = () => resolve([]);
        });
    }

    async getTrace(traceId) {
        if (typeof indexedDB === 'undefined') return null;
        if (!this.db) {
            await this.init();
        }
        if (!this.db) return null;

        return new Promise((resolve) => {
            const tx = this.db.transaction(this.storeName, "readonly");
            const store = tx.objectStore(this.storeName);
            const request = store.get(traceId);

            request.onsuccess = () => {
                if (request.result) {
                    resolve(Trace.fromJSON(request.result));
                } else {
                    resolve(null);
                }
            };
            request.onerror = () => resolve(null);
        });
    }

    async clearTraces() {
        if (typeof indexedDB === 'undefined') return;
        if (!this.db) {
            await this.init();
        }
        if (!this.db) return;

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, "readwrite");
            const store = tx.objectStore(this.storeName);
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }
}

export class OTLPTraceExporter extends SpanExporter {
    constructor({ endpointUrl = "http://localhost:4318/v1/traces", headers = {} } = {}) {
        super();
        this.endpointUrl = endpointUrl;
        this.headers = Object.assign({
            "Content-Type": "application/json"
        }, headers);
    }

    async export(trace) {
        if (typeof fetch === 'undefined') {
            console.warn("OTLPTraceExporter: fetch API not available in this environment.");
            return;
        }
        const payload = trace.toOTLP();
        try {
            const response = await fetch(this.endpointUrl, {
                method: "POST",
                headers: this.headers,
                body: JSON.stringify(payload)
            });
            if (!response.ok) {
                console.warn(`OTLPTraceExporter: Failed to export trace ${trace.traceId} to ${this.endpointUrl}. Status: ${response.status}`);
            }
        } catch (err) {
            console.warn(`OTLPTraceExporter: Network error exporting trace ${trace.traceId} to ${this.endpointUrl}:`, err.message);
        }
    }
}
