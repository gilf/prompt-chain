import { ReActAgentExecutor } from "../src/core/react-agent-executor.js";
import { PromptTemplate } from "../src/core/prompt-template.js";
import { Tool, ToolRetriever } from "../src/tools/index.js";
import { SkillRetriever } from "../src/skills/index.js";
import { JSONOutputParserRunnable } from "../src/runnables/json-output-parser-runnable.js";
import { RunnableLambda, RunnableSequence } from "../src/runnables/index.js";

// Mock in-memory store simulating AgentMemory
class MockAgentMemory {
    constructor() {
        this.store = new Map();
        this.saveHistoryCalls = 0;
        this.getHistoryCalls = 0;
    }

    async getHistory(sessionId) {
        this.getHistoryCalls++;
        return this.store.get(sessionId) || { history: [], summary: "" };
    }

    async saveHistory(sessionId, historyTurns, summary) {
        this.saveHistoryCalls++;
        this.store.set(sessionId, { history: [...historyTurns], summary });
    }

    async getCheckpoint(id) {
        return this.store.get(`chk_${id}`);
    }

    async saveCheckpoint(id, data) {
        this.store.set(`chk_${id}`, data);
    }

    async deleteCheckpoint(id) {
        this.store.delete(`chk_${id}`);
    }
}

function createTestExecutor({ memory, enableHistory = true, recordedInputs = [] }) {
    const tools = [
        new Tool("echoTool", "Echoes input", (val) => `Echo: ${val}`)
    ];
    const toolRetriever = new ToolRetriever(tools);
    const skillRetriever = new SkillRetriever([]);
    const promptTemplate = new PromptTemplate();

    const askLLM = async (prompt) => {
        return JSON.stringify({
            thought: "I will answer directly",
            toolName: "none",
            toolInput: "",
            finalAnswer: "Test answer"
        });
    };

    const inferenceStepChain = RunnableSequence.from([
        new RunnableLambda(async (input) => {
            recordedInputs.push(input);
            return JSON.stringify({
                thought: "Answering query",
                toolName: "none",
                toolInput: "",
                finalAnswer: "Answer for " + (typeof input === "object" ? input.userPrompt : input)
            });
        }),
        new JSONOutputParserRunnable()
    ]);

    return new ReActAgentExecutor({
        tools,
        skills: [],
        memory,
        toolRetriever,
        skillRetriever,
        promptTemplate,
        inferenceStepChain,
        askLLM,
        logToMain: () => {},
        enableHistory
    });
}

async function runTests() {
    console.log("=== Testing Configurable Conversation History ===");

    // Test 1: Default Behavior (enableHistory: true)
    console.log("\n--- Test 1: Default behavior (History Enabled) ---");
    const mem1 = new MockAgentMemory();
    const inputs1 = [];
    const exec1 = createTestExecutor({ memory: mem1, enableHistory: true, recordedInputs: inputs1 });

    const res1 = await exec1.invoke({ userPrompt: "First message", sessionId: "session_1" });
    if (mem1.saveHistoryCalls === 1 && mem1.getHistoryCalls === 1) {
        console.log("PASS 1.1: Default executor queried and saved history to memory.");
    } else {
        throw new Error(`FAIL 1.1: Expected 1 get and 1 save call, got ${mem1.getHistoryCalls} get, ${mem1.saveHistoryCalls} save.`);
    }

    // Turn 2 in same session: history should be loaded
    await exec1.invoke({ userPrompt: "Second message", sessionId: "session_1" });
    const sessionData = await mem1.getHistory("session_1");
    // sessionData should have 4 turns (user1, ai1, user2, ai2)
    if (sessionData.history.length === 4) {
        console.log("PASS 1.2: Second turn preserved and extended prior conversation history.");
    } else {
        throw new Error(`FAIL 1.2: Expected 4 history turns, got ${sessionData.history.length}`);
    }

    // Test 2: Stateless Agent (enableHistory: false at creation)
    console.log("\n--- Test 2: Stateless Agent (enableHistory: false at creation) ---");
    const mem2 = new MockAgentMemory();
    const inputs2 = [];
    const exec2 = createTestExecutor({ memory: mem2, enableHistory: false, recordedInputs: inputs2 });

    await exec2.invoke({ userPrompt: "Hello stateless", sessionId: "stateless_session" });

    if (mem2.saveHistoryCalls === 0 && mem2.getHistoryCalls === 0) {
        console.log("PASS 2.1: Stateless executor did not query or save history in memory.");
    } else {
        throw new Error(`FAIL 2.1: Stateless executor called memory (get: ${mem2.getHistoryCalls}, save: ${mem2.saveHistoryCalls})`);
    }

    // Check that chain input had empty historyTurns
    if (inputs2[0].historyTurns.length === 0) {
        console.log("PASS 2.2: Chain received empty history turns without loading past context.");
    } else {
        throw new Error(`FAIL 2.2: historyTurns was not empty: ${JSON.stringify(inputs2[0].historyTurns)}`);
    }

    // Second turn in stateless agent: should still have 0 saved history
    await exec2.invoke({ userPrompt: "Second stateless message", sessionId: "stateless_session" });
    if (mem2.saveHistoryCalls === 0 && inputs2[1].historyTurns.length === 0) {
        console.log("PASS 2.3: Second turn remained completely stateless.");
    } else {
        throw new Error(`FAIL 2.3: Second turn unexpectedly used history.`);
    }

    // Test 3: Per-Invocation Override (enableHistory: false on a history-enabled agent)
    console.log("\n--- Test 3: Per-Invocation Override (disable history for one call) ---");
    const mem3 = new MockAgentMemory();
    const inputs3 = [];
    const exec3 = createTestExecutor({ memory: mem3, enableHistory: true, recordedInputs: inputs3 });

    // Turn 1 with enableHistory: false override
    await exec3.invoke({ userPrompt: "One-off secret prompt", sessionId: "session_override", enableHistory: false });

    if (mem3.saveHistoryCalls === 0 && mem3.getHistoryCalls === 0) {
        console.log("PASS 3.1: Per-invocation override suppressed history retrieval and persistence.");
    } else {
        throw new Error(`FAIL 3.1: Override failed to suppress memory.`);
    }

    // Turn 2 with default (enableHistory: true)
    await exec3.invoke({ userPrompt: "Standard prompt", sessionId: "session_override" });
    if (mem3.saveHistoryCalls === 1 && mem3.getHistoryCalls === 1) {
        console.log("PASS 3.2: Subsequent standard call resumed history tracking seamlessly.");
    } else {
        throw new Error(`FAIL 3.2: Subsequent call did not resume history.`);
    }

    // Test 4: Per-Invocation Override (enableHistory: true on a history-disabled agent)
    console.log("\n--- Test 4: Per-Invocation Override (enable history for one call on stateless agent) ---");
    const mem4 = new MockAgentMemory();
    const inputs4 = [];
    const exec4 = createTestExecutor({ memory: mem4, enableHistory: false, recordedInputs: inputs4 });

    await exec4.invoke({ userPrompt: "Opt-in history prompt", sessionId: "optin_session", enableHistory: true });
    if (mem4.saveHistoryCalls === 1 && mem4.getHistoryCalls === 1) {
        console.log("PASS 4.1: Stateless agent successfully opted into history for specific invocation.");
    } else {
        throw new Error(`FAIL 4.1: Failed to opt-in to history.`);
    }

    console.log("\n🎉 ALL CONFIGURABLE HISTORY TESTS PASSED SUCCESSFULLY (4/4 tests passed)!");
}

runTests().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
