<div align="center">
  <img src="https://github.com/gilf/prompt-chain/blob/main/images/prompt-chain-logo.png" alt="Prompt Chain Logo" width="400" />
</div>

# On-Device Prompt Chain Agent

An interactive, on-device AI agent platform that runs inside a Web Worker. 
It leverages **Prompt API** for private, local, and cost-free inference, combining custom tools, modular skills, persistent long-term memory, and a declarative **LangChain Expression Language (LCEL)** pipeline architecture.

---

## Key Features

- **On-Device LLM Inference**: Runs entirely in the browser using Chrome's built-in `LanguageModel` API (`window.LanguageModel`), eliminating the need for external API keys or network latency.
- **Composable Chains & Universal Agent Runtime (LCEL)**: 
  - Features declarative primitive composition via [src/runnables/](file:///c:/Lectures/Demo/src/runnables) (`RunnableSequence`, `RunnableParallel`, `.pipe()`, `.bind()`).
  - [createAgentWorker()](file:///c:/Lectures/Demo/src/core/prompt-chain-worker.js) acts as a **Universal Agent Runtime Host**. It accepts either legacy tool arrays (to spin up default ReAct loops via `ReActAgentExecutor`) or **any custom Runnable chain topology**.
- **Asynchronous Web Worker Architecture**: 
  - [prompt-chain-host.js](file:///c:/Lectures/Demo/src/core/prompt-chain-host.js) runs on the main browser thread to manage the LLM session.
  - [prompt-chain-worker.js](file:///c:/Lectures/Demo/src/core/prompt-chain-worker.js) runs in a background thread to orchestrate the agent loop, execute tools, and handle errors, keeping the user interface completely responsive.
- **Dynamic Skill & Tool Retrieval (Lightweight RAG)**: Matches the user prompt against loaded skills and tools using a token-overlap scorer, feeding only relevant context to the prompt and preserving token limits.
- **Typed Message History & Roles (LangChain Standard)**:
  - Structures memory using standardized message objects (`HumanMessage`, `AIMessage`, `SystemMessage`, `ToolMessage`) defined in [messages.js](file:///c:/Lectures/Demo/src/messages.js).
  - Uses [agent-memory.js](file:///c:/Lectures/Demo/src/agent-memory.js) to persist object-oriented message schemas directly in **IndexedDB**.
  - Implements automatic conversation summarization (defined in [utils.js](file:///c:/Lectures/Demo/src/utils.js)) once the chat history exceeds 5 turns, ensuring the context window remains optimized.
- **Complex Structured Tool Schemas (Multi-Parameter Tools)**:
  - Tools extend `Runnable` and accept structured JSON Schema parameter definitions. Supports both legacy string inputs and complex multi-parameter objects (e.g., `bookFlight({ origin: "NYC", dest: "LAX", passengers: 2 })`).
  - Automatically validates required arguments prior to execution and generates precise self-correction feedback observations when parameters are missing.
- **Event Callbacks & Token-by-Token Streaming**:
  - Implements a global `CallbackManager` emitting structured lifecycle hooks (`on_chain_start`, `on_llm_start`, `on_llm_new_token`, `on_tool_start`, etc.).
  - Uses Chrome's `session.promptStreaming()` API across the Web Worker boundary to render live, token-by-token reasoning updates in the UI.
- **Dynamic Context Management & Rolling Summarization (`RunnableTokenBuffer`)**:
  - Bridges Chrome Prompt API token monitoring (`session.measureContextUsage()`, `session.contextUsage`, `session.contextWindow`) across the Web Worker boundary.
  - Features `RunnableTokenBuffer` LCEL primitive with a configurable watermark threshold (default **85%** of context window capacity).
  - Automatically truncates verbose single-turn tool observations and triggers rolling summarization of past conversation turns to ensure continuous ReAct loops without quota errors.
- **Human-in-the-Loop (HITL) Interruption & Checkpointing (`RunnableInterrupt`)**:
  - Implements an asynchronous safety rail for sensitive operations (e.g., modifying databases, booking flights, or external network requests).
  - When the agent attempts to invoke a tool flagged with `{ requiresApproval: true }`, the execution graph suspends and serializes its exact loop state (including sanitized context and turn history) into IndexedDB (`checkpoints` store).
  - Emits a real-time `userApprovalRequired` event to the host UI, displaying an interactive approval card where developers can review or edit JSON tool parameters.
- **Hybrid Local/Cloud Fallback & Readiness Routing (`RunnableFallback`)**:
  - **Download State Monitoring**: Hooks into Chrome's `LanguageModel.create({ monitor(m) })` to track on-device model downloading, emitting real-time `modelDownloadProgress` events (`loaded`, `total`) to display UI progress bars.
  - **Composable Readiness & Retry Routing**: Wraps the inference runtime in a `RunnableFallback` pipeline (`[localLLM, cloudFallbackLLM]`). If the local Prompt API is unavailable, rate-limited, or exceeds configurable self-correction retry limits (`maxSelfCorrectionAttempts`, default **2** attempts), execution transparently switches to `CloudFallbackLLMRunnable` (or remote fetch endpoints) without altering agent business logic or swallowing HITL interruptions.
- **Native Structured Output Enforcement & Schema Grammar (`StructuredOutputRunnable`)**:
  - Integrates JSON Schema parameter and output constraints directly into Chrome Prompt API options (`responseSchema` and `responseConstraint`).
  - Features a zero-dependency client-side recursive JSON Schema validator (`validateJSONSchema`) producing exact JSON pointer error paths (e.g., `Error at /toolInput/passengers: expected number, got string`).
  - Wraps agent inference steps inside `StructuredOutputRunnable`. If schema violations occur, exact pointer paths are intercepted and automatically injected into the ReAct self-correction loop for pinpoint model self-repair.
- **On-Device Vector RAG & Semantic Tool/Skill Retrieval (`IndexedDBVectorStore` & `RunnableRetriever`)**:
  - Features zero-dependency local vector search backed by IndexedDB (`IndexedDBVectorStore`) with exact mathematical cosine similarity ranking.
  - Exposes an extensible `EmbeddingsPlugin` interface allowing developers to plug in any custom client-side embedding generator (such as Chrome's built-in embedding API or Transformers.js WebGPU models).
  - Includes `RunnableRetriever` for declarative LCEL RAG pipelines.
  - Upgraded `ToolRetriever` and `SkillRetriever` to perform dynamic semantic pruning, filtering manifests of 50+ tools/skills down to the Top-K most relevant items before LLM prompt construction.
- **StateGraph & Multi-Agent Supervisor Swarms (`StateGraph` & `AgentSupervisor`)**:
  - Brings LangGraph-style cyclical state graphs, conditional routing, and custom channel state reducers directly to on-device Web Workers.
  - Features `AgentSupervisor` and `createAgentSupervisor` to dynamically evaluate team state and route tasks across specialized AI worker runnables using strict JSON schema output enforcement.
- **Cross-Session Episodic Memory & Semantic Fact Indexing (`RunnableEpisodicMemory`)**:
  - Features zero-dependency persistent long-term semantic memory (`RunnableEpisodicMemory`) that indexes declarative user preferences, profiles, and historical facts across multiple agent turns and sessions using `IndexedDB` (`episodes` store) and cosine vector similarity.
  - Can be piped directly into any LCEL sequence (`memory.pipe(agentExecutor)`) to automatically enrich incoming user prompts with relevant historical facts (`[SEMANTIC MEMORY (Top 5 Facts across sessions)]`), or invoked as ReAct structured tools (`memory.getTools()`) allowing the LLM to autonomously execute `remember`, `recall`, and `forget`.
- **Enterprise Observability & Tracing (LangSmith / OpenTelemetry Equivalent)**:
  - Upgrades flat callback logs into standardized hierarchical OpenTelemetry trace trees (`Trace`, `Span`). Automatically tracks parent-child span links (`parentSpanId`), timestamps, execution durations (`durationMs`), status codes (`SpanStatus.OK / ERROR`), and custom attributes.
  - Features built-in multi-destination exporters (`ConsoleTraceExporter`, `IndexedDBTraceExporter`, and `OTLPTraceExporter` for HTTP OTLP telemetry dashboards).
  - Includes a live **Interactive Trace Explorer Dashboard** in the host UI (`index.html`) with expandable parent-child tree views and one-click OTLP JSON downloads.
- **Interactive UI Stream**: A sleek interface built with HTML/CSS that displays real-time agent reasoning steps (Thoughts, Actions, and Observations), live token generation, download progress bars, interactive HITL approval cards, and trace hierarchies.

---

## File Directory & Architecture

- **[index.html](file:///c:/Lectures/Demo/index.html)** & **[styles.css](file:///c:/Lectures/Demo/styles.css)**: The frontend user interface containing input fields, suggestion chips, reasoning stream log viewports, interactive HITL approval cards, download progress bars, and loaded skills indicators.
- **[src/index.js](file:///c:/Lectures/Demo/src/index.js)**: Main package entry point exporting all library modules.
- **[src/runnables/](file:///c:/Lectures/Demo/src/runnables)**: Modular LangChain Expression Language (LCEL) primitives:
  - [runnable.js](file:///c:/Lectures/Demo/src/runnables/runnable.js): Base abstract class with `.pipe()` and `.bind()`.
  - [runnable-sequence.js](file:///c:/Lectures/Demo/src/runnables/runnable-sequence.js): Sequential chaining (`RunnableSequence.from`).
  - [runnable-parallel.js](file:///c:/Lectures/Demo/src/runnables/runnable-parallel.js): Parallel graph branching (`RunnableParallel`).
  - [runnable-lambda.js](file:///c:/Lectures/Demo/src/runnables/runnable-lambda.js): Function wrapping (`RunnableLambda`).
  - [runnable-passthrough.js](file:///c:/Lectures/Demo/src/runnables/runnable-passthrough.js): Identity mapping & assignment (`RunnablePassthrough.assign`).
  - [runnable-token-buffer.js](file:///c:/Lectures/Demo/src/runnables/runnable-token-buffer.js): Context window watermark truncation & summarization.
  - [runnable-interrupt.js](file:///c:/Lectures/Demo/src/runnables/runnable-interrupt.js) & [interrupt-exception.js](file:///c:/Lectures/Demo/src/runnables/interrupt-exception.js): Human-in-the-Loop suspension rails.
  - [runnable-fallback.js](file:///c:/Lectures/Demo/src/runnables/runnable-fallback.js): Hybrid local/cloud model fallback routing.
  - [structured-output-runnable.js](file:///c:/Lectures/Demo/src/runnables/structured-output-runnable.js) & [validate-json-schema.js](file:///c:/Lectures/Demo/src/runnables/validate-json-schema.js): JSON Schema validation and pinpoint self-repair.
  - [runnable-retriever.js](file:///c:/Lectures/Demo/src/runnables/runnable-retriever.js): Declarative LCEL vector and semantic retriever primitive.
  - [runnable-episodic-memory.js](file:///c:/Lectures/Demo/src/runnables/runnable-episodic-memory.js): Persistent cross-session semantic facts and profile memory (`RunnableEpisodicMemory`).
  - [state-graph.js](file:///c:/Lectures/Demo/src/runnables/state-graph.js): LangGraph-style cyclical state graphs (`StateGraph`, `CompiledStateGraph`) with conditional routing and reducers.
  - [agent-supervisor.js](file:///c:/Lectures/Demo/src/runnables/agent-supervisor.js): LLM-powered multi-agent supervisor router (`AgentSupervisor`, `createAgentSupervisor`).
- **[src/retrievers/](file:///c:/Lectures/Demo/src/retrievers)**:
  - [indexeddb-vector-store.js](file:///c:/Lectures/Demo/src/retrievers/indexeddb-vector-store.js): Zero-dependency local vector store backed by IndexedDB (`IndexedDBVectorStore`), pluggable embedding interface (`EmbeddingsPlugin`), and exact `cosineSimilarity` calculation.
  - [semantic-retriever.js](file:///c:/Lectures/Demo/src/retrievers/semantic-retriever.js): Unified base retriever class (`SemanticRetriever`) providing vector cosine pruning and token overlap fallback.
- **[src/observability/](file:///c:/Lectures/Demo/src/observability)**:
  - [trace.js](file:///c:/Lectures/Demo/src/observability/trace.js): Core hierarchical primitives (`SpanStatus`, `Span`, `Trace`, and hex ID generation).
  - [tracer.js](file:///c:/Lectures/Demo/src/observability/tracer.js): Active span stack manager and trace execution singleton (`Tracer`).
  - [exporters.js](file:///c:/Lectures/Demo/src/observability/exporters.js): Standardized trace exporters (`SpanExporter`, `ConsoleTraceExporter`, `IndexedDBTraceExporter`, `OTLPTraceExporter`).
  - [index.js](file:///c:/Lectures/Demo/src/observability/index.js): Observability package module entry point.
- **[src/skills/](file:///c:/Lectures/Demo/src/skills)**:
  - [skill.js](file:///c:/Lectures/Demo/src/skills/skill.js): Dynamic skill loader and markdown frontmatter parser.
  - [skill-retriever.js](file:///c:/Lectures/Demo/src/skills/skill-retriever.js): Semantic skill retriever extending `SemanticRetriever`.
- **[src/tools/](file:///c:/Lectures/Demo/src/tools)**:
  - [tool-retriever.js](file:///c:/Lectures/Demo/src/tools/tool-retriever.js): Semantic tool retriever extending `SemanticRetriever`.
- **[src/core/](file:///c:/Lectures/Demo/src/core)**:
  - [prompt-chain-host.js](file:///c:/Lectures/Demo/src/core/prompt-chain-host.js): Main thread session manager, event dispatcher, and Prompt API host bridge.
  - [prompt-chain-worker.js](file:///c:/Lectures/Demo/src/core/prompt-chain-worker.js): Universal Web Worker agent runtime host & `ReActAgentExecutor`.
  - [callbacks.js](file:///c:/Lectures/Demo/src/core/callbacks.js): Global `CallbackManager` for structured event emitting and cross-thread token streaming.
  - [messages.js](file:///c:/Lectures/Demo/src/core/messages.js): Standard LangChain typed message classes (`HumanMessage`, `AIMessage`, `SystemMessage`, `ToolMessage`).
  - [prompt-template.js](file:///c:/Lectures/Demo/src/core/prompt-template.js): LCEL-pipeable prompt formatting component.
  - [agent-memory.js](file:///c:/Lectures/Demo/src/core/agent-memory.js): IndexedDB persistent conversation storage manager.
- **[src/examples/](file:///c:/Lectures/Demo/src/examples)**:
  - [my-agent.js](file:///c:/Lectures/Demo/src/examples/my-agent.js): Default Web Worker entry point running global tools and dynamic skills.
  - [custom-runner-demo.js](file:///c:/Lectures/Demo/src/examples/custom-runner-demo.js): Demonstration of custom linear QA topologies.
  - [supervisor-demo.js](file:///c:/Lectures/Demo/src/examples/supervisor-demo.js): Demonstration of an LLM-supervised multi-agent swarm (`Researcher` + `MathExpert`).
- **[tests/](file:///c:/Lectures/Demo/tests)**: Complete automated test suites covering LCEL runnables, HITL interrupts, callbacks, token buffers, structured tools, fallback routing, structured output, on-device vector RAG, and cyclical state graph / multi-agent supervisor swarms ([test-state-graph.js](file:///c:/Lectures/Demo/tests/test-state-graph.js)).


---

## LCEL Chaining & Runnable Usage Guide

### 1. Sequential Chaining (`RunnableSequence` & `.pipe()`)
Compose multiple runnables or functions step-by-step:
```javascript
import { RunnableSequence, RunnableLambda } from './src/index.js';

// Using .pipe()
const addOne = new RunnableLambda(async (x) => x + 1);
const multiplyTwo = new RunnableLambda(async (x) => x * 2);
const chain = addOne.pipe(multiplyTwo);

console.log(await chain.invoke(3)); // Output: 8

// Or declarative array syntax:
const arrayChain = RunnableSequence.from([
    async (text) => text.trim(),
    async (text) => text.toUpperCase()
]);
console.log(await arrayChain.invoke("  hello world  ")); // Output: "HELLO WORLD"
```

### 2. Parallel Branching (`RunnableParallel`)
Execute multiple runnables concurrently on the same input object:
```javascript
import { RunnableParallel } from './src/index.js';

const parallel = new RunnableParallel({
    charCount: async (text) => text.length,
    wordCount: async (text) => text.split(/\s+/).filter(Boolean).length
});

const stats = await parallel.invoke("Prompt Chain runs on device!");
// Output: { charCount: 28, wordCount: 5 }
```

### 3. State Enrichment (`RunnablePassthrough.assign`)
Attach computed properties to an incoming input dictionary without mutating or dropping existing fields:
```javascript
import { RunnablePassthrough } from './src/index.js';

const enrichChain = RunnablePassthrough.assign({
    timestamp: async () => new Date().toISOString(),
    normalizedTopic: async (input) => input.topic.toLowerCase()
});

const enriched = await enrichChain.invoke({ topic: "AI Agents", user: "Alice" });
// Output: { topic: "AI Agents", user: "Alice", timestamp: "...", normalizedTopic: "ai agents" }
```

### 4. Structured Output Enforcement (`StructuredOutputRunnable`)
Force an LLM or pipeline step to produce strictly validated JSON matching a JSON Schema:
```javascript
import { StructuredOutputRunnable } from './src/index.js';

const schema = {
    type: "object",
    properties: {
        city: { type: "string" },
        temp: { type: "number" }
    },
    required: ["city", "temp"]
};

// Wraps any runnable; intercepts markdown fences and validates properties
const structuredChain = new StructuredOutputRunnable(mockLLMRunnable, schema);
const res = await structuredChain.invoke("The weather in Tokyo is 22C");
// Output: { success: true, parsed: { city: "Tokyo", temp: 22 } }
```

### 5. Readiness & Self-Repair Fallbacks (`RunnableFallback`)
Automatically route to a backup model or cloud endpoint if local on-device inference fails or exceeds self-correction limits:
```javascript
import { RunnableFallback } from './src/index.js';

const robustLLM = new RunnableFallback([
    localOnDeviceLLM, // Tries Chrome window.LanguageModel first
    cloudFallbackLLM  // Switches to cloud API if local model fails or is rate-limited
], {
    onFallback: async (err, failedRunnable, nextRunnable) => {
        console.warn(`Local model failed (${err.message}), falling back to remote endpoint...`);
    }
});
```

### 6. Default ReAct Agent Mode
Passing an array of tools to `createAgentWorker` automatically instantiates the built-in `ReActAgentExecutor`:
```javascript
import { Tool, createAgentWorker } from './src/index.js';

const calcTool = new Tool("Calculator", "Evaluates math", expr => eval(expr));
createAgentWorker([calcTool]); // Runs standard 7-turn ReAct reasoning loop
```

### 7. Custom Agent Topologies (Bypassing ReAct)
You can pass **any custom Runnable chain** directly into `createAgentWorker()`:
```javascript
import { RunnableSequence, RunnableLambda, createAgentWorker } from './src/index.js';

const directAnswerChain = RunnableSequence.from([
    new RunnableLambda(async ({ userPrompt, logToMain }) => {
        logToMain("Thought: Bypassing ReAct loop for linear execution...");
        return `Answer directly: ${userPrompt}`;
    }),
    myLLMRunnable // Any custom model wrapper or pipeline step
]);
```

### 8. Human-in-the-Loop Interruption (`requiresApproval`)
Flag sensitive tools with `{ requiresApproval: true }` to suspend execution before high-impact operations occur:
```javascript
// Worker side (my-agent.js)
const bookFlightTool = new Tool(
    "bookFlight",
    "Books a flight ticket.",
    async ({ origin, dest, passengers }) => `Booked flight to ${dest}!`,
    flightSchema,
    { requiresApproval: true } // Execution pauses right before running this tool
);

// Host UI side (index.html)
window.addEventListener(CallbackEvents.eventDispatch, (e) => {
    if (e.detail.event === CallbackEvents.userApprovalRequired) {
        const { checkpointId, toolName, toolInput } = e.detail;
        // Prompt human user for review or modifications...
        host.resume(checkpointId, approvedToolInput); // Rehydrate state and complete execution
    }
});
```

### 9. StateGraph & Multi-Agent Supervisor Swarms
Orchestrate complex cyclical workflows and multi-agent swarms using LangGraph-style state graphs and LLM supervisors:
```javascript
import { Tool, StateGraph, START, END, createAgentSupervisor, createAgentWorker, RunnableLambda } from './src/index.js';

// 1. Define specialized worker runnables
const researcherAgent = new RunnableLambda(async (state) => {
    const res = await searchTool.invoke(state.userPrompt);
    return { messages: [`Researcher: ${res}`] };
});

const mathAgent = new RunnableLambda(async (state) => {
    const res = await calcTool.invoke("542 * 13");
    return { messages: [`MathExpert: ${res}`], finalAnswer: res };
});

// 2. Create an LLM Supervisor Router
const supervisor = createAgentSupervisor({
    agents: [
        { name: "Researcher", description: "Searches documentation and specs" },
        { name: "MathExpert", description: "Performs mathematical calculations" }
    ]
});

// 3. Build the cyclical StateGraph with state reducers
const graph = new StateGraph({
    reducers: { messages: (old, add) => (old || []).concat(add) }
});

graph.addNode("supervisor", supervisor);
graph.addNode("Researcher", researcherAgent);
graph.addNode("MathExpert", mathAgent);

// 4. Connect cyclical routing: Supervisor -> Worker -> Supervisor -> END
graph.setEntryPoint("supervisor");
graph.addConditionalEdges("supervisor", (state) => state.next, {
    "Researcher": "Researcher",
    "MathExpert": "MathExpert",
    "FINISH": END
});
graph.addEdge("Researcher", "supervisor");
graph.addEdge("MathExpert", "supervisor");

// 5. Host compiled swarm inside Web Worker runtime!
createAgentWorker(graph.compile());
```

### 10. Enterprise Observability & OpenTelemetry Tracing (`Tracer` & Exporters)
Bridge flat lifecycle events into hierarchical parent-child span trees with multi-destination export (Console DevTools, local IndexedDB, or remote OTLP collectors like Jaeger / OpenTelemetry Collector):
```javascript
import { Tracer, ConsoleTraceExporter, IndexedDBTraceExporter, OTLPTraceExporter, CallbackManager, createAgentWorker } from './src/index.js';

// 1. Initialize hierarchical Tracer with desired exporters
const tracer = new Tracer("ProductionAgentTracer")
    .addExporter(new ConsoleTraceExporter()) // Styled parent-child tree logs in DevTools
    .addExporter(new IndexedDBTraceExporter("AgentMemoryDB", "traces")) // Persistent local storage
    .addExporter(new OTLPTraceExporter({ endpointUrl: "http://localhost:4318/v1/traces" })); // OTLP HTTP JSON

// 2. Attach Tracer to CallbackManager (or pass directly to worker runtime)
const callbacks = new CallbackManager().attachTracer(tracer);

// 3. Spans (`AgentExecution` -> `LLMInference` / `Tool.Calculator`) are generated automatically!
createAgentWorker(myAgentRunnable, [], callbacks);
```

### 11. Cross-Session Episodic Memory & Semantic Profile Indexing (`RunnableEpisodicMemory`)
Enable long-term fact retention across sessions. `RunnableEpisodicMemory` stores facts in IndexedDB (`episodes` store) with cosine semantic similarity indices. It can be used in two complementary ways:

#### A. ReAct Structured Tools (`memory.getTools()`)
Equip ReAct agents with structured tools (`remember`, `recall`, `forget`) so the LLM can autonomously manage and recall user profiles and facts:
```javascript
import { Tool, createAgentWorker, RunnableEpisodicMemory } from './src/index.js';

const episodicMemory = new RunnableEpisodicMemory({ dbName: "AgentMemoryDB", storeName: "episodes" });

// Equip worker with standard tools AND episodic memory tools
createAgentWorker([
    fetchTool,
    mathTool,
    ...episodicMemory.getTools()
]);
```

#### B. LCEL Pipeline Prompt Enrichment (`memory.pipe(agentExecutor)`)
Automatically enrich incoming user queries with relevant historical facts before they reach the LLM:
```javascript
import { RunnableEpisodicMemory, ReActAgentExecutor } from './src/index.js';

const episodicMemory = new RunnableEpisodicMemory({ dbName: "AgentMemoryDB", storeName: "episodes" });
const agentExecutor = new ReActAgentExecutor(toolsArray);

// Pipe semantic memory directly into agent loop:
// Enriches state.userPrompt with "[SEMANTIC MEMORY (Top 5 Facts across sessions): ...]"
const memoryAwareAgent = episodicMemory.pipe(agentExecutor);
```

---

## Prerequisites (How to Setup Chrome Built-in AI)

This project requires a Chrome version (or Chromium-based browser like Chrome Canary) with the experimental Prompt API enabled.

1. Open Google Chrome.
2. Navigate to `chrome://flags/#optimization-guide-on-device-model` and set it to **Enabled BypassPrefRequirement** (or **Enabled**).
3. Navigate to `chrome://flags/#prompt-api-for-gemini-nano` and set it to **Enabled**.
4. Relaunch Chrome.
5. Wait for the on-device model to download in the background (you can verify it by opening DevTools console and checking if `window.LanguageModel` is defined).

---

## How to Run the Project

Because the project loads ES6 modules (`import/export`) and spins up Web Workers dynamically, opening `index.html` directly from your file system (`file://` protocol) will fail due to CORS security policies. You **must** serve it using a local web server.

### Option 1: Using Node.js (npx)
```bash
npx serve
```

### Option 2: Using Python
```bash
python -m http.server 8000
```

---

## License

This project is licensed under the [MIT License](file:///c:/Lectures/Demo/LICENSE).
