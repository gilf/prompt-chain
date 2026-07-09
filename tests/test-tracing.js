import assert from 'assert';
import { SpanStatus, Trace, Tracer, ConsoleTraceExporter, IndexedDBTraceExporter, OTLPTraceExporter, CallbackManager, CallbackEvents } from '../src/index.js';

async function runTests() {
    console.log("Starting Enterprise Observability & Tracing Tests...\n");

    // Test 1: Span & Trace hierarchy creation and duration tracking
    console.log("Test 1: Span & Trace hierarchy and duration tracking...");
    const trace = new Trace({ name: "TestTrace", attributes: { user: "tester" } });
    assert.strictEqual(trace.name, "TestTrace");
    assert.strictEqual(trace.attributes.user, "tester");

    const rootSpan = trace.startSpan("RootChain", { kind: "INTERNAL", attributes: { step: 1 } });
    assert.ok(rootSpan.spanId, "Span ID generated");
    assert.strictEqual(rootSpan.parentSpanId, null, "Root span has no parent initially");
    assert.strictEqual(trace.rootSpanId, rootSpan.spanId, "Trace sets rootSpanId");

    const llmSpan = trace.startSpan("LLMCall", { parentSpanId: rootSpan.spanId, kind: "CLIENT" });
    assert.strictEqual(llmSpan.parentSpanId, rootSpan.spanId, "Child span correctly linked to root span");

    // Add inline event
    llmSpan.addEvent("llm_new_token", { token: "Hello" });
    assert.strictEqual(llmSpan.events.length, 1);
    assert.strictEqual(llmSpan.events[0].name, "llm_new_token");
    assert.strictEqual(llmSpan.events[0].attributes.token, "Hello");

    // End child span
    trace.endSpan(llmSpan.spanId, { code: SpanStatus.OK });
    assert.strictEqual(llmSpan.status.code, SpanStatus.OK);
    assert.ok(typeof llmSpan.durationMs === "number", "Duration calculated");

    // End root span
    trace.endSpan(rootSpan.spanId, { code: SpanStatus.OK });
    assert.strictEqual(trace.status.code, SpanStatus.OK);
    assert.ok(typeof trace.durationMs === "number", "Trace duration calculated");
    console.log("✅ Test 1 Passed: Trace & Span hierarchy verified.\n");

    // Test 2: OpenTelemetry OTLP JSON Schema formatting
    console.log("Test 2: OpenTelemetry OTLP JSON formatting...");
    const otlp = trace.toOTLP();
    assert.ok(otlp.resourceSpans, "otlp.resourceSpans present");
    assert.strictEqual(otlp.resourceSpans.length, 1);
    const scopeSpans = otlp.resourceSpans[0].scopeSpans;
    assert.strictEqual(scopeSpans.length, 1);
    assert.strictEqual(scopeSpans[0].scope.name, "prompt-chain.observability");
    const spansList = scopeSpans[0].spans;
    assert.strictEqual(spansList.length, 2, "Both rootSpan and llmSpan exported");
    assert.strictEqual(spansList[0].traceId, trace.traceId);
    assert.ok(spansList[0].startTimeUnixNano.length > 5, "Unix nano timestamp generated");
    console.log("✅ Test 2 Passed: OpenTelemetry OTLP schema structure validated.\n");

    // Test 3: CallbackManager automatic Tracer bridging
    console.log("Test 3: CallbackManager automatic OpenTelemetry bridging...");
    let exportedTrace = null;
    const tracer = new Tracer("BridgeTracer");
    tracer.addExporter({
        async export(t) {
            exportedTrace = t;
        }
    });

    const callbackManager = new CallbackManager();
    callbackManager.attachTracer(tracer);

    // Simulate ReAct loop callbacks
    callbackManager.dispatch(CallbackEvents.chainStart, { name: "ReActChainExecution", userPrompt: "What is 2+2?" });
    assert.ok(tracer.activeTrace, "Active trace started by chainStart");
    assert.strictEqual(tracer.activeSpanStack.length, 1, "Root span pushed to stack");

    callbackManager.dispatch(CallbackEvents.llmStart, { loopCount: 1 });
    assert.strictEqual(tracer.activeSpanStack.length, 2, "LLM span pushed to stack");
    const llmId = tracer.activeSpanStack[1];

    callbackManager.dispatch(CallbackEvents.llmNewToken, { token: "4" });
    const llmSpanObj = tracer.activeTrace.spans.get(llmId);
    assert.strictEqual(llmSpanObj.events.length, 1, "Token event added to active LLM span");

    callbackManager.dispatch(CallbackEvents.llmEnd, { response: "4" });
    assert.strictEqual(tracer.activeSpanStack.length, 1, "LLM span popped from stack");

    callbackManager.dispatch(CallbackEvents.toolStart, { toolName: "Calculator", toolInput: "2+2" });
    assert.strictEqual(tracer.activeSpanStack.length, 2, "Tool span pushed to stack");
    const toolSpanId = tracer.activeSpanStack[1];
    assert.strictEqual(tracer.activeTrace.spans.get(toolSpanId).name, "Tool.Calculator");

    callbackManager.dispatch(CallbackEvents.toolEnd, { toolName: "Calculator", toolResult: "4" });
    assert.strictEqual(tracer.activeSpanStack.length, 1, "Tool span popped from stack");

    callbackManager.dispatch(CallbackEvents.chainEnd, { finalOutput: "The answer is 4." });
    assert.strictEqual(tracer.activeSpanStack.length, 0, "Root span popped from stack");
    assert.strictEqual(tracer.activeTrace, null, "Tracer activeTrace cleared after root completion");
    assert.ok(exportedTrace, "Exporter triggered upon root chainEnd");
    assert.strictEqual(exportedTrace.spans.size, 3, "Trace contains 3 hierarchical spans (Chain, LLM, Tool)");
    console.log("✅ Test 3 Passed: CallbackManager bridge correctly generates parent-child span trees.\n");

    // Test 4: Exporters Verification (Console & OTLP safe instantiation)
    console.log("Test 4: Exporters verification...");
    const consoleExporter = new ConsoleTraceExporter();
    await consoleExporter.export(trace); // Should print cleanly to console

    const otlpExporter = new OTLPTraceExporter({ endpointUrl: "http://localhost:4318/v1/traces" });
    assert.strictEqual(otlpExporter.headers["Content-Type"], "application/json");

    const idbExporter = new IndexedDBTraceExporter();
    assert.strictEqual(idbExporter.storeName, "traces");
    console.log("✅ Test 4 Passed: Exporters instantiated and validated.\n");

    console.log("🎉 ALL OBSERVABILITY & TRACING TESTS PASSED (4/4 tests passed)!");
}

runTests().catch(err => {
    console.error("❌ Test Failed:", err);
    process.exit(1);
});
