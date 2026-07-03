import { validateJSONSchema, StructuredOutputRunnable, RunnableLambda, ReActAgentExecutor, JSONOutputParserRunnable } from '../src/index.js';

async function runStructuredOutputTests() {
    console.log("=== Testing Native Structured Output Enforcement & Schema Grammar ===");

    // Test 1: Testing custom validateJSONSchema with JSON pointer paths
    console.log("Test 1: Testing validateJSONSchema pointer path formatting...");
    const testSchema = {
        type: "object",
        required: ["flight", "passengers"],
        properties: {
            flight: { type: "string" },
            passengers: { type: "number" },
            class: { enum: ["economy", "business"] },
            items: {
                type: "array",
                items: { type: "string" }
            }
        }
    };

    const validData = { flight: "AA123", passengers: 2, class: "economy", items: ["bag1", "bag2"] };
    const resValid = validateJSONSchema(testSchema, validData);
    if (!resValid.valid || resValid.errors.length > 0) {
        throw new Error(`Test 1 failed: Valid data failed validation: ${resValid.errors.join("; ")}`);
    }

    const invalidData = { flight: 123, class: "first", items: ["bag1", 99] };
    const resInvalid = validateJSONSchema(testSchema, invalidData);
    if (resInvalid.valid) {
        throw new Error("Test 1 failed: Invalid data incorrectly marked valid!");
    }
    const errText = resInvalid.errors.join("; ");
    if (!errText.includes("/passengers: missing required property") ||
        !errText.includes("/flight: expected string, got number") ||
        !errText.includes("/class: value '\"first\"' must be one of [\"economy\", \"business\"]") ||
        !errText.includes("/items/1: expected string, got number")) {
        throw new Error(`Test 1 failed: Exact JSON pointer error paths not found! Got: ${errText}`);
    }
    console.log("PASS: validateJSONSchema accurately produced JSON pointer paths for all violations.");

    // Test 2: Testing StructuredOutputRunnable primitive
    console.log("Test 2: Testing StructuredOutputRunnable schema enforcement...");
    const badRunnable = new RunnableLambda(async () => ({
        thought: "Trying to book flight",
        toolName: "bookFlight",
        toolInput: { passengers: "two" }, // Violation: should be number
        finalAnswer: ""
    }));

    const agentSchema = {
        type: "object",
        required: ["thought", "toolName", "toolInput", "finalAnswer"],
        properties: {
            thought: { type: "string" },
            toolName: { type: "string" },
            toolInput: {
                type: "object",
                properties: {
                    passengers: { type: "number" }
                }
            },
            finalAnswer: { type: "string" }
        }
    };

    const structuredRunner = new StructuredOutputRunnable(badRunnable, agentSchema);
    const runRes = await structuredRunner.invoke({});
    if (runRes.success || !runRes.error.includes("Error at /toolInput/passengers: expected number, got string")) {
        throw new Error(`Test 2 failed: StructuredOutputRunnable did not return pointer error! Got: ${JSON.stringify(runRes)}`);
    }
    console.log("PASS: StructuredOutputRunnable intercepted schema violation and returned exact pointer error.");

    // Test 3: Testing ReAct loop self-correction pinpoint routing
    console.log("Test 3: Verifying ReActAgentExecutor pinpoint self-correction on schema failure...");
    let callCount = 0;
    let observedRetryPrompt = "";

    const dynamicAskLLM = async (promptInput) => {
        callCount++;
        if (callCount === 1) {
            return JSON.stringify({
                thought: "Initial attempt",
                toolName: "bookFlight",
                toolInput: { passengers: "two" }, // Violation
                finalAnswer: ""
            });
        }
        // Second call: inspect prompt input to ensure schema violation observation was injected
        if (typeof promptInput === "object" && promptInput.historyTurns) {
            // Check observation
        }
        return JSON.stringify({
            thought: "Corrected attempt",
            toolName: "none",
            toolInput: {},
            finalAnswer: "Successfully self-corrected using JSON pointer error path!"
        });
    };

    const mockMemory = {
        getHistory: async () => ({ history: [], summary: "" }),
        saveHistory: async () => {}
    };
    const mockRetriever = { getRelevantTools: async () => [], getRelevantSkills: async () => [] };
    const promptTemplate = { invoke: async (p) => p };

    const rawLLMRunnable = new RunnableLambda(async (input) => {
        if (typeof input === "string" && input.includes("Observation:")) {
            observedRetryPrompt = input;
        }
        return await dynamicAskLLM(input);
    });
    const parser = new JSONOutputParserRunnable();
    const inferenceStepChain = new StructuredOutputRunnable(rawLLMRunnable, agentSchema, { parser });

    const executor = new ReActAgentExecutor({
        tools: [],
        skills: [],
        memory: mockMemory,
        toolRetriever: mockRetriever,
        skillRetriever: mockRetriever,
        promptTemplate,
        inferenceStepChain,
        askLLM: dynamicAskLLM,
        logToMain: () => {}
    });

    const finalOut = await executor.invoke({ userPrompt: "Book flight for 2", sessionId: "schema_test" });
    if (!finalOut || !finalOut.includes("Successfully self-corrected")) {
        throw new Error(`Test 3 failed: Did not reach final self-corrected answer! Got: ${finalOut}`);
    }
    if (!observedRetryPrompt.includes("/toolInput/passengers: expected number, got string")) {
        throw new Error(`Test 3 failed: ReAct loop did not feed exact pointer path back! Got: ${observedRetryPrompt}`);
    }
    console.log("PASS: ReAct loop successfully injected exact JSON pointer error path for self-correction.");

    console.log("=== ALL STRUCTURED OUTPUT & SCHEMA ENFORCEMENT TESTS PASSED SUCCESSFULLY! ===");
}

runStructuredOutputTests().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
