import { BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage } from '../src/index.js';

function runMessageTests() {
    console.log("=== Testing LangChain Typed Messages ===");

    // Test 1: HumanMessage
    const human = new HumanMessage("Hello AI!");
    const json1 = human.toJSON();
    console.log("HumanMessage JSON:", JSON.stringify(json1));
    if (json1.type !== "human" || json1.content !== "Hello AI!") throw new Error("HumanMessage test failed!");

    // Test 2: AIMessage with tool_calls
    const ai = new AIMessage("Let me check weather", {
        tool_calls: [{ name: "GetWeather", args: { city: "Tokyo" } }]
    });
    const json2 = ai.toJSON();
    console.log("AIMessage JSON:", JSON.stringify(json2));
    if (ai.tool_calls[0].name !== "GetWeather") throw new Error("AIMessage tool_calls failed!");

    // Test 3: Deserialization factory
    const restored = BaseMessage.fromJSON(json2);
    console.log("Restored type:", restored.getType());
    if (!(restored instanceof AIMessage) || restored.content !== "Let me check weather") {
        throw new Error("Factory restoration failed!");
    }

    // Test 4: ToolMessage
    const tool = new ToolMessage("Sunny, 25C", "GetWeather");
    const json4 = tool.toJSON();
    console.log("ToolMessage JSON:", JSON.stringify(json4));
    if (tool.tool_name !== "GetWeather" || json4.type !== "tool") throw new Error("ToolMessage test failed!");

    console.log("=== ALL MESSAGE TESTS PASSED SUCCESSFULLY! ===");
}

runMessageTests();
