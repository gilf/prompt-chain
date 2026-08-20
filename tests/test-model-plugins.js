import {
    BaseModelPlugin,
    ChromeBuiltInAIPlugin,
    OllamaPlugin,
    TransformersJSPlugin,
    CustomModelPlugin,
    LLMSessionManager,
    PromptChainHost,
    MessageContext
} from '../src/index.js';


async function runModelPluginTests() {
    console.log("=== Testing Pluggable Model Plugin Architecture ===");

    // Test 1: BaseModelPlugin abstract interface contract
    console.log("Test 1: Testing BaseModelPlugin base class & fallback estimation...");
    class MinimalPlugin extends BaseModelPlugin {}
    const basePlugin = new MinimalPlugin();
    
    let caughtAbstractErr = false;
    try {
        await basePlugin.generate("test");
    } catch (e) {
        caughtAbstractErr = true;
    }
    if (!caughtAbstractErr) {
        throw new Error("Test 1 failed: BaseModelPlugin did not throw on abstract generate()!");
    }
    const tokenEst = await basePlugin.measureContextUsage("Hello World!");
    if (tokenEst !== 3) { // 12 chars / 4 = 3
        throw new Error(`Test 1 failed: Expected token estimate 3, got ${tokenEst}`);
    }
    console.log("PASS: BaseModelPlugin base class contract verified.");

    // Test 2: CustomModelPlugin functional callbacks
    console.log("Test 2: Testing CustomModelPlugin functional callbacks...");
    let customGenCalled = false;
    let customInitCalled = false;
    const customPlugin = new CustomModelPlugin({
        initFn: async () => { customInitCalled = true; },
        generateFn: async (payload, onToken) => {
            customGenCalled = true;
            if (typeof onToken === 'function') {
                onToken("Token1 ");
                onToken("Token2");
            }
            return JSON.stringify({ thought: "Custom plugin executed", finalAnswer: "Custom output" });
        },
        measureContextFn: async () => 42,
        getStatsFn: () => ({ usage: 100, window: 8192 })
    });

    await customPlugin.init("System instruct");
    const streamTokens = [];
    const customRes = await customPlugin.generate({ prompt: "Hi" }, (t) => streamTokens.push(t));
    const measured = await customPlugin.measureContextUsage("test");
    const stats = customPlugin.getContextStats();

    if (!customInitCalled || !customGenCalled || streamTokens.join("") !== "Token1 Token2" || measured !== 42 || stats.window !== 8192) {
        throw new Error("Test 2 failed: CustomModelPlugin callbacks did not behave as expected!");
    }
    console.log("PASS: CustomModelPlugin executed functional callbacks successfully.");

    // Test 3: OllamaPlugin native REST API request & streaming reader
    console.log("Test 3: Testing OllamaPlugin REST payload & native fetch streaming...");
    let capturedUrl = "";
    let capturedBody = null;

    const mockFetch = async (url, opts) => {
        capturedUrl = url;
        capturedBody = JSON.parse(opts.body);

        const chunks = [
            JSON.stringify({ message: { role: "assistant", content: "Ollama " }, eval_count: 5 }),
            JSON.stringify({ message: { role: "assistant", content: "response." }, eval_count: 10 })
        ];
        
        const stream = new ReadableStream({
            start(controller) {
                for (const c of chunks) {
                    controller.enqueue(new TextEncoder().encode(c + "\n"));
                }
                controller.close();
            }
        });

        return new Response(stream, { status: 200 });
    };

    const ollama = new OllamaPlugin({
        model: "mistral",
        baseUrl: "http://localhost:11434",
        apiEndpoint: "/api/chat",
        fetch: mockFetch
    });

    await ollama.init("You are a helpful assistant.");
    const ollamaTokens = [];
    const ollamaRes = await ollama.generate({ prompt: "What is 2+2?", schema: { type: "object" } }, (t) => ollamaTokens.push(t));

    if (capturedUrl !== "http://localhost:11434/api/chat") {
        throw new Error(`Test 3 failed: Incorrect URL target ${capturedUrl}`);
    }
    if (capturedBody.model !== "mistral" || capturedBody.format !== "json") {
        throw new Error("Test 3 failed: Ollama request payload missing model or json format flag!");
    }
    if (capturedBody.messages[0].content !== "You are a helpful assistant.") {
        throw new Error("Test 3 failed: Ollama system prompt not injected correctly!");
    }
    if (ollamaRes !== "Ollama response." || ollamaTokens.join("") !== "Ollama response.") {
        throw new Error(`Test 3 failed: Streaming response mismatch, got '${ollamaRes}'`);
    }
    console.log("PASS: OllamaPlugin correctly built request payload and streamed NDJSON chunks.");

    // Test 4: TransformersJSPlugin with custom pipelineLoader
    console.log("Test 4: Testing TransformersJSPlugin in-browser ONNX model execution...");
    let pipelineLoaded = false;
    const mockPipeline = async (formattedInput) => {
        return [{ generated_text: `${formattedInput} -> Simulated ONNX Output` }];
    };
    mockPipeline.tokenizer = {
        encode: (str) => new Array(str.length).fill(0)
    };

    const transformersPlugin = new TransformersJSPlugin({
        modelId: "Xenova/Qwen1.5-0.5B-Chat",
        pipelineLoader: async () => {
            pipelineLoaded = true;
            return mockPipeline;
        }
    });

    await transformersPlugin.init("System Instructions");
    const tfRes = await transformersPlugin.generate({ prompt: "Classify text" });
    const tfUsage = await transformersPlugin.measureContextUsage("12345");

    if (!pipelineLoaded || !tfRes.includes("Simulated ONNX Output") || tfUsage !== 5) {
        throw new Error("Test 4 failed: TransformersJSPlugin pipeline execution error!");
    }
    console.log("PASS: TransformersJSPlugin initialized and executed ONNX pipeline loader.");

    // Test 5: Integration with LLMSessionManager & PromptChainHost
    console.log("Test 5: Testing LLMSessionManager & PromptChainHost model plugin integration...");
    
    let streamCapturedInWorker = "";
    class MockWorker {
        constructor() {
            this.onmessage = null;
        }
        postMessage(msg) {
            if (msg.type === MessageContext.llmStreamToken) {
                streamCapturedInWorker += msg.payload;
            }
        }
        terminate() {}
    }

    const mockWorker = new MockWorker();
    const hostWithOllama = new PromptChainHost(mockWorker, {
        model: ollama
    });

    await hostWithOllama.init("Host System Prompt");

    await hostWithOllama.messageHandlers[MessageContext.llmRequest](101, { prompt: "Test host integration" });

    if (hostWithOllama.llmManager.modelPlugin !== ollama) {
        throw new Error("Test 5 failed: Host LLMSessionManager did not receive configured model plugin!");
    }
    if (streamCapturedInWorker !== "Ollama response.") {
        throw new Error(`Test 5 failed: Stream tokens were not forwarded to worker! Got: '${streamCapturedInWorker}'`);
    }

    hostWithOllama.terminate();
    console.log("PASS: PromptChainHost seamlessly integrated with pluggable model provider.");

    console.log("=== ALL MODEL PLUGIN TESTS PASSED SUCCESSFULLY! ===");
}


runModelPluginTests().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
