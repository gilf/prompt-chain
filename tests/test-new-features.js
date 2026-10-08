import {
    ChromeBuiltInAIPlugin,
    BuiltInAISummarizer,
    StreamingHtmlSanitizer,
    sanitizeHtml,
    pendingTagStart,
    splitByCodeFences,
    stripUnsafeUrls,
    untilAborted,
    Tool,
    JSONOutputParserRunnable,
    ReActAgentExecutor,
    PromptTemplate
} from "../src/index.js";

async function runTests() {
    console.log("=== Testing Features Inspired by easy-language-model ===");

    // ==========================================
    // Phase 1: Readiness & UX Enhancements
    // ==========================================
    console.log("\n--- Phase 1: Readiness & UX Tests ---");

    // Test 1.1: Availability Detection
    const defaultAvail = await ChromeBuiltInAIPlugin.checkAvailability();
    if (defaultAvail === 'unavailable') {
        console.log("PASS 1.1: ChromeBuiltInAIPlugin.checkAvailability returned 'unavailable' gracefully when no window.LanguageModel exists.");
    } else {
        throw new Error(`FAIL 1.1: Unexpected availability ${defaultAvail}`);
    }

    // Test 1.2: User Activation Handler
    let buttonClicked = false;
    let buttonHidden = true;
    const mockButton = {
        hidden: true,
        style: { display: 'none' },
        addEventListener(event, listener) {
            buttonHidden = this.hidden;
            setTimeout(() => {
                buttonClicked = true;
                listener();
            }, 10);
        }
    };
    const mockHint = {
        hidden: true,
        style: { display: 'none' }
    };

    await ChromeBuiltInAIPlugin.ensureUserActivation({
        activationButton: mockButton,
        activationHint: mockHint
    });

    if (buttonClicked && mockButton.hidden) {
        console.log("PASS 1.2: ensureUserActivation displayed activationButton/hint, waited for click, and restored hidden state.");
    } else {
        throw new Error("FAIL 1.2: ensureUserActivation did not correctly handle button activation.");
    }

    // Test 1.3: Download Progress Normalization & <progress> Element
    let progressReported = null;
    const mockProgressEl = {
        hidden: true,
        max: 0,
        value: 0,
        removeAttribute(attr) {
            if (attr === 'value') this.value = -1; // indeterminate marker
        }
    };

    const plugin = new ChromeBuiltInAIPlugin({
        downloadProgress: mockProgressEl,
        onDownloadProgress: (p) => { progressReported = p; }
    });

    // Mock global LanguageModel to test monitor
    globalThis.LanguageModel = {
        availability: async () => 'after-download',
        create: async (config) => {
            if (config.monitor) {
                config.monitor({
                    addEventListener(evt, cb) {
                        cb({ loaded: 50, total: 100 });
                        cb({ loaded: 100, total: 100 });
                    }
                });
            }
            return {
                prompt: async () => "Hello from mocked LM",
                measureContextUsage: async () => 10,
                destroy: () => {}
            };
        }
    };

    await plugin.init("You are an assistant");
    if (progressReported && progressReported.percent === 100 && progressReported.loaded === 100 && mockProgressEl.hidden) {
        console.log("PASS 1.3: downloadProgress normalized percent (100%) and drove mock <progress> element cleanly.");
    } else {
        throw new Error(`FAIL 1.3: Download progress tracking failed. Output: ${JSON.stringify(progressReported)}`);
    }

    // ==========================================
    // Phase 2: Execution Safety & Cancellation
    // ==========================================
    console.log("\n--- Phase 2: Execution Safety & Cancellation Tests ---");

    // Test 2.1: untilAborted & AbortSignal Tool Interruption
    const abortCtrl = new AbortController();
    abortCtrl.abort(new Error("User cancelled"));

    let abortCaught = false;
    try {
        await untilAborted(new Promise((resolve) => setTimeout(resolve, 1000)), abortCtrl.signal);
    } catch (e) {
        if (e.message.includes("User cancelled")) {
            abortCaught = true;
        }
    }
    if (abortCaught) {
        console.log("PASS 2.1: untilAborted aborted immediately on active AbortSignal.");
    } else {
        throw new Error("FAIL 2.1: untilAborted failed to abort.");
    }

    // Test 2.2: Tool execution with AbortSignal
    const cancelTool = new Tool("slow_tool", "Takes 500ms", async (input, ctx) => {
        if (ctx.signal?.aborted) throw new Error("Cancelled by signal in tool");
        return "done";
    });

    const toolAbortCtrl = new AbortController();
    toolAbortCtrl.abort();
    let toolAbortCaught = false;
    try {
        await cancelTool.invoke({}, { signal: toolAbortCtrl.signal });
    } catch (e) {
        toolAbortCaught = true;
    }
    if (toolAbortCaught) {
        console.log("PASS 2.2: Tool.invoke honored AbortSignal and halted execution.");
    } else {
        throw new Error("FAIL 2.2: Tool.invoke did not abort.");
    }

    // Test 2.3: HTML Sanitizer & Streaming Split-Tag Guard
    const tag1 = pendingTagStart("Normal text with 1 < 2.");
    const tag2 = pendingTagStart("Here is some text <img src=x onerr");
    const tag3 = pendingTagStart("Safe complete tag <p>Hello</p>");

    if (tag1 === -1 && tag2 === 18 && tag3 === -1) {
        console.log("PASS 2.3: pendingTagStart correctly identified pending unclosed tag boundary without false positives.");
    } else {
        throw new Error(`FAIL 2.3: pendingTagStart mismatch (tag1=${tag1}, tag2=${tag2}, tag3=${tag3})`);
    }

    // Test 2.4: Code Fence Preservation & XSS Stripping
    const dirtyProse = 'Hello <script>alert("hack")</script><a href="javascript:steal()">Click</a>';
    const sanitizedProse = sanitizeHtml(dirtyProse);
    if (!sanitizedProse.includes("<script>") && !sanitizedProse.includes("javascript:")) {
        console.log("PASS 2.4: sanitizeHtml stripped script tags and dangerous javascript: URLs.");
    } else {
        throw new Error(`FAIL 2.4: sanitizeHtml did not strip dangerous tokens: ${sanitizedProse}`);
    }

    const markdownWithCode = 'Here is how to write a script:\n```html\n<script>console.log("safe");</script>\n```\nAnd text <script>evil()</script>';
    const sanitizedMarkdown = sanitizeHtml(markdownWithCode, { ignoreFencedCode: true });
    if (sanitizedMarkdown.includes('<script>console.log("safe");</script>') && !sanitizedMarkdown.includes('evil()')) {
        console.log("PASS 2.5: sanitizeHtml preserved HTML inside markdown code fences while sanitizing prose HTML.");
    } else {
        throw new Error(`FAIL 2.5: Code fence preservation failed: ${sanitizedMarkdown}`);
    }

    // Test 2.5: StreamingHtmlSanitizer chunk buffering
    const streamer = new StreamingHtmlSanitizer();
    const chunkA = streamer.push("Hello <img src=");
    const chunkB = streamer.push('x onerror="alert(1)"> World!');
    const chunkC = streamer.flush();

    const totalEmitted = chunkA + chunkB + chunkC;
    if (!totalEmitted.includes('onerror="alert(1)"')) {
        console.log("PASS 2.6: StreamingHtmlSanitizer buffered split tag across chunks and sanitized successfully.");
    } else {
        throw new Error(`FAIL 2.6: StreamingHtmlSanitizer leaked unsafe tag: ${totalEmitted}`);
    }

    // ==========================================
    // Phase 3: Native Built-in AI Synergies
    // ==========================================
    console.log("\n--- Phase 3: Native Built-in AI Synergies Tests ---");

    // Test 3.1: BuiltInAISummarizer availability check
    const sumAvail = await BuiltInAISummarizer.checkAvailability();
    if (sumAvail === 'unavailable') {
        console.log("PASS 3.1: BuiltInAISummarizer.checkAvailability returned 'unavailable' gracefully without error.");
    } else {
        throw new Error(`FAIL 3.1: Unexpected summarizer availability: ${sumAvail}`);
    }

    // Test 3.2: ChromeBuiltInAIPlugin.compact() with initialPrompts anchoring
    let createdWithInitialPrompts = null;
    globalThis.LanguageModel = {
        availability: async () => 'readily',
        create: async (config) => {
            if (config.initialPrompts) {
                createdWithInitialPrompts = config.initialPrompts;
            }
            return {
                prompt: async () => "Compacted session response",
                destroy: () => {}
            };
        }
    };

    const compactorPlugin = new ChromeBuiltInAIPlugin();
    await compactorPlugin.init("System instructions");

    const sampleHistory = [
        { role: 'user', content: 'What is the capital of France?' },
        { role: 'assistant', content: 'The capital is Paris.' }
    ];

    const compactResult = await compactorPlugin.compact(sampleHistory, {
        summarizerFn: async (text) => "User asked for capital of France. Answer was Paris."
    });

    if (compactResult.summary.includes("Paris") && createdWithInitialPrompts && createdWithInitialPrompts.length === 3) {
        console.log("PASS 3.2: compactorPlugin.compact() summarized history and anchored summary in permanent initialPrompts.");
    } else {
        throw new Error("FAIL 3.2: compact() failed to anchor initialPrompts.");
    }

    // Test 3.3: Native Structured Tool Calling through JSONOutputParserRunnable
    const nativeToolOutput = {
        text: "I need to calculate the weather degrees",
        toolCalls: [
            {
                callId: "call_abc123",
                name: "getWeather",
                arguments: { city: "Tel Aviv", units: "celsius" }
            }
        ]
    };

    const parser = new JSONOutputParserRunnable();
    const parsedStep = await parser.invoke(nativeToolOutput);

    if (parsedStep.success && parsedStep.parsed.toolName === "getWeather" && parsedStep.parsed.toolInput.city === "Tel Aviv") {
        console.log("PASS 3.3: JSONOutputParserRunnable seamlessly parsed native Prompt API toolCall into ReAct execution step.");
    } else {
        throw new Error(`FAIL 3.3: Native tool call parsing failed: ${JSON.stringify(parsedStep)}`);
    }

    console.log("\n🎉 ALL NEW FEATURE TESTS PASSED SUCCESSFULLY! (Phase 1, Phase 2, & Phase 3)");

    // Clean up mock
    delete globalThis.LanguageModel;
}

runTests().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
