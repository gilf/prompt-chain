import { CallbackManager } from '../src/index.js';

async function runCallbackTests() {
    console.log("=== Testing Event Callbacks & Token Streaming ===");

    const eventsFired = [];
    let accumulatedTokens = "";

    const cbManager = new CallbackManager({
        on_chain_start: (data) => eventsFired.push(`chain_start:${data.userPrompt}`),
        on_llm_start: (data) => eventsFired.push(`llm_start`),
        on_llm_new_token: (data) => {
            eventsFired.push(`token:${data.token}`);
            accumulatedTokens += data.token;
        },
        on_llm_end: (data) => eventsFired.push(`llm_end`),
        on_chain_end: (data) => eventsFired.push(`chain_end:${data.finalOutput}`)
    });

    console.log("Test 1: Triggering lifecycle and streaming token events...");
    cbManager.dispatch("on_chain_start", { userPrompt: "Hello Agent" });
    cbManager.dispatch("on_llm_start", { prompt: "Test prompt" });
    
    // Simulate streaming tokens
    const streamTokens = ["{", '"thought"', ": ", '"Thinking..."', " }"];
    for (const t of streamTokens) {
        cbManager.dispatch("on_llm_new_token", { token: t });
    }

    cbManager.dispatch("on_llm_end", { response: accumulatedTokens });
    cbManager.dispatch("on_chain_end", { finalOutput: "Done!" });

    console.log("Events fired:", eventsFired);
    console.log("Accumulated streamed text:", accumulatedTokens);

    if (accumulatedTokens !== '{"thought": "Thinking..." }') {
        throw new Error("Token accumulation mismatch!");
    }

    if (eventsFired[0] !== "chain_start:Hello Agent" || eventsFired[eventsFired.length - 1] !== "chain_end:Done!") {
        throw new Error("Lifecycle event mismatch!");
    }

    console.log("=== ALL CALLBACK & STREAMING TESTS PASSED SUCCESSFULLY! ===");
}

runCallbackTests().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
