import { StateGraph, START, END, RunnableLambda, createAgentSupervisor, CallbackManager, CallbackEvents } from '../src/index.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
        console.log(`✅ PASS: ${message}`);
    } else {
        failed++;
        console.error(`❌ FAIL: ${message}`);
    }
}

async function runTests() {
    console.log("=== Running StateGraph & Multi-Agent Supervisor Tests ===\n");

    // Test 1: Linear Graph Execution
    try {
        const graph = new StateGraph();
        graph.addNode("step1", new RunnableLambda(async (state) => ({ count: (state.count || 0) + 1 })));
        graph.addNode("step2", new RunnableLambda(async (state) => ({ count: state.count * 10 })));
        graph.setEntryPoint("step1");
        graph.addEdge("step1", "step2");
        graph.setFinishPoint("step2");

        const compiled = graph.compile();
        const res = await compiled.invoke({ count: 5 });
        assert(res.count === 60, `Linear graph execution passed (expected 60, got ${res.count})`);
    } catch (e) {
        assert(false, `Linear graph test failed: ${e.message}`);
    }

    // Test 2: State Reducers
    try {
        const graph = new StateGraph({
            reducers: {
                messages: (old, add) => (old || []).concat(add)
            }
        });
        graph.addNode("agentA", async (state) => ({ messages: ["Hello from A"] }));
        graph.addNode("agentB", async (state) => ({ messages: ["Hello from B"] }));
        graph.setEntryPoint("agentA");
        graph.addEdge("agentA", "agentB");
        graph.setFinishPoint("agentB");

        const compiled = graph.compile();
        const res = await compiled.invoke({ messages: ["Initial"] });
        assert(
            Array.isArray(res.messages) && res.messages.length === 3 && res.messages[2] === "Hello from B",
            `State reducers concatenated messages properly (${JSON.stringify(res.messages)})`
        );
    } catch (e) {
        assert(false, `State reducers test failed: ${e.message}`);
    }

    // Test 3: Conditional Branching & Loops (Generator/Evaluator loop)
    try {
        const graph = new StateGraph();
        graph.addNode("generator", async (state) => ({ attempt: (state.attempt || 0) + 1 }));
        graph.addNode("evaluator", async (state) => ({ approved: state.attempt >= 3 }));
        
        graph.setEntryPoint("generator");
        graph.addEdge("generator", "evaluator");
        graph.addConditionalEdges("evaluator", (state) => state.approved ? "done" : "retry", {
            "retry": "generator",
            "done": END
        });

        const compiled = graph.compile();
        const res = await compiled.invoke({ attempt: 0 });
        assert(res.attempt === 3 && res.approved === true, `Cyclical conditional graph looped 3 times until approved`);
    } catch (e) {
        assert(false, `Conditional loop test failed: ${e.message}`);
    }

    // Test 4: Max Iterations Protection (Infinite Loop)
    try {
        const graph = new StateGraph();
        graph.addNode("loop", async (state) => ({ val: (state.val || 0) + 1 }));
        graph.setEntryPoint("loop");
        graph.addEdge("loop", "loop"); // Infinite loop

        const compiled = graph.compile({ maxIterations: 10 });
        let threw = false;
        try {
            await compiled.invoke({ val: 0 });
        } catch (err) {
            threw = true;
            assert(err.message.includes("exceeded maximum iterations"), `Infinite loop caught by maxIterations limit`);
        }
        if (!threw) assert(false, `Infinite loop did not throw an error`);
    } catch (e) {
        assert(false, `Max iterations test failed: ${e.message}`);
    }

    // Test 5: Graph Compilation Validation
    try {
        const graph = new StateGraph();
        graph.addNode("A", async () => ({}));
        graph.addEdge("A", "NonExistentNode");
        graph.setEntryPoint("A");
        
        let threw = false;
        try {
            graph.compile();
        } catch (err) {
            threw = true;
            assert(err.message.includes("does not exist"), `Compilation validation caught non-existent edge target`);
        }
        if (!threw) assert(false, `Compilation validation did not catch invalid edge target`);
    } catch (e) {
        assert(false, `Compilation validation test failed: ${e.message}`);
    }

    // Test 6: Agent Supervisor Routing
    try {
        let turn = 0;
        const mockAskLLM = async (prompt, schema) => {
            turn++;
            if (turn === 1) {
                return JSON.stringify({ next: "WorkerA", reason: "Need data from Worker A" });
            } else {
                return JSON.stringify({ next: "FINISH", reason: "Task complete" });
            }
        };

        const supervisor = createAgentSupervisor({
            agents: [
                { name: "WorkerA", description: "Does work A" },
                { name: "WorkerB", description: "Does work B" }
            ],
            askLLM: mockAskLLM
        });

        const graph = new StateGraph({
            reducers: {
                log: (old, add) => (old || []).concat(add)
            }
        });

        graph.addNode("supervisor", supervisor);
        graph.addNode("WorkerA", async () => ({ log: ["Executed WorkerA"] }));
        graph.addNode("WorkerB", async () => ({ log: ["Executed WorkerB"] }));

        graph.setEntryPoint("supervisor");
        graph.addConditionalEdges("supervisor", (state) => state.next, {
            "WorkerA": "WorkerA",
            "WorkerB": "WorkerB",
            "FINISH": END
        });
        graph.addEdge("WorkerA", "supervisor");
        graph.addEdge("WorkerB", "supervisor");

        const compiled = graph.compile();
        const res = await compiled.invoke({ log: [], askLLM: mockAskLLM });
        
        assert(
            res.log.length === 1 && res.log[0] === "Executed WorkerA" && (res.next === "FINISH" || res.next === "__END__"),
            `Supervisor successfully routed to WorkerA and then finished (${JSON.stringify(res)})`
        );

    } catch (e) {
        assert(false, `Supervisor routing test failed: ${e.message}`);
    }

    // Test 7: Callback Event Dispatching
    try {
        let events = [];
        const callbackManager = new CallbackManager();
        callbackManager.addHandler(CallbackEvents.graphStart, (p) => events.push("graphStart"));
        callbackManager.addHandler(CallbackEvents.nodeStart, (p) => events.push(`nodeStart:${p.node}`));
        callbackManager.addHandler(CallbackEvents.nodeEnd, (p) => events.push(`nodeEnd:${p.node}`));
        callbackManager.addHandler(CallbackEvents.graphEnd, (p) => events.push("graphEnd"));

        const graph = new StateGraph();
        graph.addNode("X", async () => ({ val: 1 }));
        graph.setEntryPoint("X");
        graph.setFinishPoint("X");
        const compiled = graph.compile();
        
        await compiled.invoke({}, { callbacks: callbackManager });
        assert(
            events.join(",") === "graphStart,nodeStart:X,nodeEnd:X,graphEnd",
            `Graph structured callbacks dispatched correctly (${events.join(",")})`
        );
    } catch (e) {
        assert(false, `Callback dispatch test failed: ${e.message}`);
    }

    console.log(`\n=== Test Summary ===`);
    console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
    if (failed > 0) {
        process.exit(1);
    }
}

runTests();
