import { Tool, RunnableInterrupt, InterruptException } from '../src/index.js';

async function runHitlTests() {
    console.log("=== Testing Human-in-the-Loop (HITL) Interruption & Checkpointing ===");

    // Test 1: RunnableInterrupt primitive throwing InterruptException
    console.log("Test 1: Testing RunnableInterrupt primitive...");
    const interrupt = new RunnableInterrupt({
        checkFn: (input) => input.requiresReview === true,
        onInterrupt: (input) => ({ toolName: input.action, params: input.params })
    });

    let caughtInterrupt = false;
    try {
        await interrupt.invoke({ action: "bookFlight", params: { origin: "NYC", dest: "LAX" }, requiresReview: true });
    } catch (e) {
        if (e instanceof InterruptException || e.name === "InterruptException") {
            caughtInterrupt = true;
            console.log("Caught expected InterruptException:", e.message, e.payload);
            if (e.payload.toolName !== "bookFlight") {
                throw new Error("Wrong payload in InterruptException!");
            }
        } else {
            throw e;
        }
    }
    if (!caughtInterrupt) {
        throw new Error("Test 1 failed: RunnableInterrupt did not throw InterruptException!");
    }

    // Test 2: Tool with requiresApproval flag
    console.log("Test 2: Verifying Tool requiresApproval configuration...");
    const sensitiveTool = new Tool(
        "deleteDatabase",
        "Deletes all records",
        async () => "DELETED",
        null,
        { requiresApproval: true }
    );
    if (!sensitiveTool.requiresApproval) {
        throw new Error("Test 2 failed: sensitiveTool.requiresApproval is not true!");
    }
    console.log("Verified sensitive tool has requiresApproval = true.");

    // Test 3: Checkpoint serialization and rehydration simulation
    console.log("Test 3: Simulating checkpoint state serialization and rehydration...");
    const mockCheckpoints = new Map();
    const mockMemory = {
        saveCheckpoint: async (id, data) => mockCheckpoints.set(id, data),
        getCheckpoint: async (id) => mockCheckpoints.get(id) || null,
        deleteCheckpoint: async (id) => mockCheckpoints.delete(id)
    };

    const chkId = "chk_test_session_001";
    const checkpointState = {
        sessionId: "session_123",
        userPrompt: "Book flight to LAX",
        loopCount: 2,
        pendingToolName: "bookFlight",
        pendingToolInput: { origin: "NYC", dest: "LAX", passengers: 1 }
    };

    await mockMemory.saveCheckpoint(chkId, checkpointState);
    const retrieved = await mockMemory.getCheckpoint(chkId);
    console.log("Retrieved checkpoint:", retrieved);
    if (retrieved.pendingToolName !== "bookFlight" || retrieved.pendingToolInput.passengers !== 1) {
        throw new Error("Test 3 failed: Checkpoint data mismatch upon rehydration!");
    }
    await mockMemory.deleteCheckpoint(chkId);
    if (await mockMemory.getCheckpoint(chkId) !== null) {
        throw new Error("Test 3 failed: Checkpoint deletion failed!");
    }

    console.log("=== ALL HITL INTERRUPTION & CHECKPOINTING TESTS PASSED SUCCESSFULLY! ===");
}

runHitlTests().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
