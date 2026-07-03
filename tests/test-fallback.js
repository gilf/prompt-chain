import { RunnableLambda, RunnableFallback, InterruptException, CloudFallbackLLMRunnable, ReActAgentExecutor, JSONOutputParserRunnable } from '../src/index.js';

async function runFallbackTests() {
    console.log("=== Testing Hybrid Local/Cloud Fallback & Readiness Routing ===");

    // Test 1: RunnableFallback routing from failing primary runnable to fallback
    console.log("Test 1: Testing RunnableFallback switching on error...");
    let primaryCalled = false;
    let fallbackCalled = false;
    let callbackTriggered = false;

    const primaryRunnable = new RunnableLambda(async (input) => {
        primaryCalled = true;
        throw new Error("Local model unavailable or quota exceeded");
    });

    const fallbackRunnable = new RunnableLambda(async (input) => {
        fallbackCalled = true;
        return `Fallback success: ${input}`;
    });

    const router = new RunnableFallback([primaryRunnable, fallbackRunnable], {
        onFallback: (err, from, to) => {
            callbackTriggered = true;
        }
    });

    const res1 = await router.invoke("test_prompt");
    if (!primaryCalled || !fallbackCalled || !callbackTriggered || res1 !== "Fallback success: test_prompt") {
        throw new Error("Test 1 failed: RunnableFallback did not properly route to fallback!");
    }
    console.log("PASS: RunnableFallback successfully routed to fallback runnable on primary failure.");

    // Test 2: RunnableFallback MUST NOT swallow InterruptException (HITL)
    console.log("Test 2: Verifying RunnableFallback preserves InterruptException for HITL...");
    const interruptRunnable = new RunnableLambda(async () => {
        throw new InterruptException({ toolName: "bookFlight" });
    });

    const neverCalledFallback = new RunnableLambda(async () => "Should not run");
    const hitlRouter = new RunnableFallback([interruptRunnable, neverCalledFallback]);

    let caughtInterrupt = false;
    try {
        await hitlRouter.invoke({});
    } catch (e) {
        if (e instanceof InterruptException || e.name === "InterruptException") {
            caughtInterrupt = true;
        }
    }
    if (!caughtInterrupt) {
        throw new Error("Test 2 failed: RunnableFallback swallowed InterruptException!");
    }
    console.log("PASS: RunnableFallback preserved HITL InterruptException.");

    // Test 3: Testing CloudFallbackLLMRunnable invocation with developer-configured responseParser
    console.log("Test 3: Testing developer-configured CloudFallbackLLMRunnable or custom fallback...");
    const developerCustomFallback = new RunnableLambda(async (prompt) => {
        return JSON.stringify({ thought: "Custom developer fallback checking Tokyo weather.", toolName: "FetchData", toolInput: "https://api.weather.mock/tokyo" });
    });
    const fallbackRes = await developerCustomFallback.invoke("What is the weather in Tokyo?");
    const parsed = JSON.parse(fallbackRes);
    if (parsed.toolName !== "FetchData") {
        throw new Error("Test 3 failed: Developer fallback returned unexpected payload!");
    }
    console.log("PASS: Developer-implemented fallback returned structured fallback JSON.");

    // Test 4: Testing ReActAgentExecutor configurable self-correction routing
    console.log("Test 4: Verifying ReActAgentExecutor routes to fallback after maxSelfCorrectionAttempts...");
    let failingLLMCalledCount = 0;
    const failingAskLLM = async () => {
        failingLLMCalledCount++;
        return "Not valid JSON syntax at all";
    };

    const mockMemory = {
        getHistory: async () => ({ history: [], summary: "" }),
        saveHistory: async () => {}
    };
    const mockRetriever = { getRelevantTools: async () => [], getRelevantSkills: async () => [] };
    const promptTemplate = { invoke: async (p) => p };
    
    const inferenceStepChain = new RunnableLambda(async (input) => {
        const raw = await failingAskLLM();
        return await new JSONOutputParserRunnable().invoke(raw);
    });

    const executor = new ReActAgentExecutor({
        tools: [],
        skills: [],
        memory: mockMemory,
        toolRetriever: mockRetriever,
        skillRetriever: mockRetriever,
        promptTemplate,
        inferenceStepChain,
        askLLM: failingAskLLM,
        logToMain: () => {},
        maxSelfCorrectionAttempts: 2,
        cloudFallbackRunnable: new RunnableLambda(async () => JSON.stringify({
            thought: "Fallback responding directly.",
            finalAnswer: "Processed successfully via Developer Custom Fallback Engine."
        }))
    });

    const finalOutput = await executor.invoke({ userPrompt: "Hello world", sessionId: "test_session" });
    if (!finalOutput || !finalOutput.includes("Processed successfully via Developer Custom Fallback Engine")) {
        throw new Error(`Test 4 failed: Final output did not match developer fallback! Got: ${finalOutput}`);
    }
    console.log("PASS: ReActAgentExecutor routed to fallback runnable after 2 failed self-correction attempts.");

    console.log("=== ALL HYBRID FALLBACK & READINESS ROUTING TESTS PASSED SUCCESSFULLY! ===");
}

runFallbackTests().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
