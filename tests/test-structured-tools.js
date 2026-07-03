import { Tool, RunnableSequence, RunnableLambda } from '../src/index.js';

async function runStructuredToolTests() {
    console.log("=== Testing Structured Multi-Parameter Tools (LCEL) ===");

    // Define a multi-parameter structured tool
    const flightSchema = {
        type: "object",
        properties: {
            origin: { type: "string" },
            dest: { type: "string" },
            passengers: { type: "integer" }
        },
        required: ["origin", "dest", "passengers"]
    };

    const bookFlightTool = new Tool(
        "bookFlight",
        "Book flight tickets",
        async ({ origin, dest, passengers }) => `Confirmation: Flight booked from ${origin} to ${dest} for ${passengers} passengers.`,
        flightSchema
    );

    // Test 1: Direct LCEL invocation with valid structured object
    console.log("Test 1: Direct invocation with valid object...");
    const res1 = await bookFlightTool.invoke({ origin: "NYC", dest: "LAX", passengers: 2 });
    console.log("Result:", res1);
    if (!res1.includes("Confirmation: Flight booked from NYC to LAX for 2 passengers")) {
        throw new Error("Test 1 failed!");
    }

    // Test 2: Validation interception when missing required parameters
    console.log("Test 2: Invocation missing required 'passengers' parameter...");
    let threw = false;
    try {
        await bookFlightTool.invoke({ origin: "NYC", dest: "LAX" });
    } catch (e) {
        threw = true;
        console.log("Caught expected validation error:", e.message);
        if (!e.message.includes("missing required parameter")) {
            throw new Error("Wrong error message thrown!");
        }
    }
    if (!threw) throw new Error("Test 2 failed: Did not throw validation error!");

    // Test 3: Chaining structured tool inside RunnableSequence
    console.log("Test 3: Chaining inside RunnableSequence...");
    const customPipeline = RunnableSequence.from([
        new RunnableLambda(async (input) => ({ origin: input.from, dest: input.to, passengers: input.count })),
        bookFlightTool
    ]);
    const res3 = await customPipeline.invoke({ from: "LHR", to: "JFK", count: 4 });
    console.log("Pipeline Result:", res3);
    if (!res3.includes("from LHR to JFK for 4 passengers")) {
        throw new Error("Test 3 failed!");
    }

    console.log("=== ALL STRUCTURED TOOL TESTS PASSED SUCCESSFULLY! ===");
}

runStructuredToolTests().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
