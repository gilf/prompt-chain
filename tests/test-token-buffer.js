import { RunnableTokenBuffer, RunnableLambda, pruneObservation, compressHistory } from "../src/index.js";

async function runTests() {
    console.log("=== Testing Dynamic Context Management (RunnableTokenBuffer) ===");

    // Test 1: Pruning long observations
    console.log("Test 1: Testing observation pruning...");
    const longObservation = "A".repeat(15000);
    const pruned = pruneObservation(longObservation, 1000); // maxTokens = 1000 => maxChars = 3000
    if (pruned.length < longObservation.length && pruned.includes("[Observation Truncated due to Token Buffer]")) {
        console.log(`PASS: Long observation pruned from ${longObservation.length} to ${pruned.length} chars.`);
    } else {
        throw new Error("FAIL: Observation was not pruned properly.");
    }

    // Test 2: RunnableTokenBuffer below threshold
    console.log("Test 2: Testing RunnableTokenBuffer below threshold...");
    const dummyRunnable = new RunnableLambda(async (input) => `Processed: ${input}`);
    const bufferLow = new RunnableTokenBuffer({
        boundRunnable: dummyRunnable,
        measureTokensFn: async (input) => ({ count: 100 }), // 100 tokens
        getStatsFn: async () => ({ window: 4000 }), // window 4000, 85% is 3400
        thresholdRatio: 0.85
    });
    const resLow = await bufferLow.invoke("Short input");
    if (resLow === "Processed: Short input") {
        console.log("PASS: RunnableTokenBuffer allowed input untouched below threshold.");
    } else {
        throw new Error(`FAIL: Unexpected output: ${resLow}`);
    }

    // Test 3: RunnableTokenBuffer exceeding threshold
    console.log("Test 3: Testing RunnableTokenBuffer exceeding threshold...");
    let summarizeCalled = false;
    const bufferHigh = new RunnableTokenBuffer({
        boundRunnable: dummyRunnable,
        measureTokensFn: async (input) => ({ count: 3600 }), // 3600 > 3400 threshold
        getStatsFn: async () => ({ window: 4000 }),
        thresholdRatio: 0.85,
        pruneObservationFn: (input) => input,
        summarizeFn: (input) => {
            summarizeCalled = true;
            return "Summarized input";
        }
    });
    const resHigh = await bufferHigh.invoke("Huge input exceeding threshold");
    if (summarizeCalled && resHigh === "Processed: Summarized input") {
        console.log("PASS: RunnableTokenBuffer triggered summarization when exceeding threshold.");
    } else {
        throw new Error("FAIL: RunnableTokenBuffer did not summarize above threshold.");
    }

    // Test 4: compressHistory token measurement
    console.log("Test 4: Testing compressHistory with token limits...");
    const mockTurns = [
        { type: 'human', content: 'Turn 1' },
        { type: 'ai', content: 'Turn 2' },
        { type: 'human', content: 'Turn 3' }
    ];
    let llmCalled = false;
    const mockAskLLM = async (prompt) => {
        llmCalled = true;
        return "New Summary";
    };
    const mockLog = (msg) => {};
    
    // With token limit exceeded (maxTokens: 50, measure returns 100)
    const compressed = await compressHistory(mockTurns, "Old Summary", mockAskLLM, mockLog, {
        measureTokensFn: async () => ({ count: 100 }),
        maxTokens: 50
    });
    if (llmCalled && compressed.updatedSummary === "New Summary" && compressed.historyTurns.length === 2) {
        console.log("PASS: compressHistory triggered compression due to token limit overload.");
    } else {
        throw new Error("FAIL: compressHistory did not compress properly under token constraints.");
    }

    console.log("=== ALL TOKEN BUFFER & CONTEXT MANAGEMENT TESTS PASSED SUCCESSFULLY! ===");
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
