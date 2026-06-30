<div align="center">
  <img src="https://github.com/gilf/prompt-chain/blob/main/images/prompt-chain-logo.png" alt="Prompt Chain Logo" width="400" />
</div>

# On-Device Prompt Chain Agent

An interactive, on-device AI agent platform that runs autonomous loops inside a Web Worker. 
It leverages Chrome's experimental **built-in Gemini Prompt API** for private, local, and cost-free inference, combining custom tools, modular skills, persistent long-term memory, and a declarative **LangChain Expression Language (LCEL)** pipeline architecture.

---

## Key Features

- **On-Device LLM Inference**: Runs entirely in the browser using Chrome's built-in `LanguageModel` API (`window.LanguageModel`), eliminating the need for external API keys or network latency.
- **Composable Chains & Universal Agent Runtime (LCEL)**: 
  - Features declarative primitive composition via [runnable.js](file:///c:/Lectures/Demo/runnable.js) (`RunnableSequence`, `RunnableParallel`, `.pipe()`, `.bind()`).
  - [createAgentWorker()](file:///c:/Lectures/Demo/prompt-chain-worker.js) acts as a **Universal Agent Runtime Host**. It accepts either legacy tool arrays (to spin up default ReAct loops via `ReActAgentExecutor`) or **any custom Runnable chain topology**.
- **Asynchronous Web Worker Architecture**: 
  - [prompt-chain-host.js](file:///c:/Lectures/Demo/prompt-chain-host.js) runs on the main browser thread to manage the LLM session.
  - [prompt-chain-worker.js](file:///c:/Lectures/Demo/prompt-chain-worker.js) runs in a background thread to orchestrate the agent loop, execute tools, and handle errors, keeping the user interface completely responsive.
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
- **Interactive UI Stream**: A sleek interface built with HTML/CSS that displays real-time agent reasoning steps (Thoughts, Actions, and Observations) alongside live token generation.

---

## File Directory & Architecture

- **[index.html](file:///c:/Lectures/Demo/index.html)** & **[styles.css](file:///c:/Lectures/Demo/styles.css)**: The frontend user interface containing input fields, suggestion chips, reasoning stream log viewports, and loaded skills indicators.
- **[callbacks.js](file:///c:/Lectures/Demo/src/callbacks.js)**: Global `CallbackManager` for structured event emitting and cross-thread token streaming.
- **[messages.js](file:///c:/Lectures/Demo/src/messages.js)**: Standard LangChain typed message classes (`HumanMessage`, `AIMessage`, `SystemMessage`, `ToolMessage`).
- **[runnable.js](file:///c:/Lectures/Demo/src/runnable.js)**: Core LCEL primitives (`Runnable`, `RunnableSequence`, `RunnableParallel`, `RunnableLambda`, `RunnablePassthrough`, `RunnableBinding`).
- **[my-agent.js](file:///c:/Lectures/Demo/src/my-agent.js)**: The default Web Worker entry point. Defines global tools (`Calculator`, `FetchData`), loads dynamic skills, and spins up a ReAct loop.
- **[custom-runner-demo.js](file:///c:/Lectures/Demo/src/custom-runner-demo.js)**: Demonstration of spinning up the worker using a custom linear QA Runnable pipeline instead of ReAct.
- **[prompt-chain-worker.js](file:///c:/Lectures/Demo/src/prompt-chain-worker.js)**: Universal runtime manager. Encapsulates `ReActAgentExecutor`, `LLMRunnable`, and `JSONOutputParserRunnable`.
- **[prompt-chain-host.js](file:///c:/Lectures/Demo/src/prompt-chain-host.js)**: Manages main thread events, initializes Chrome's built-in model, translates LLM requests from the worker, and dispatches log streams to the UI.
- **[prompt-template.js](file:///c:/Lectures/Demo/src/prompt-template.js)**: LCEL-pipeable prompt formatting component.
- **[agent-memory.js](file:///c:/Lectures/Demo/src/agent-memory.js)**: IndexedDB persistent conversation storage manager.
- **[skills/](file:///c:/Lectures/Demo/skills)**:
  - **[weather/](file:///c:/Lectures/Demo/skills/weather)**: Sample modular skill containing [SKILL.md](file:///c:/Lectures/Demo/skills/weather/SKILL.md) and mock tools.

---

## LCEL Chaining & Universal Runtime Examples

### 1. Default ReAct Agent Mode
Passing an array of tools to `createAgentWorker` automatically instantiates the built-in `ReActAgentExecutor`:
```javascript
import { Tool, createAgentWorker } from './prompt-chain-worker.js';

const calcTool = new Tool("Calculator", "Evaluates math", expr => eval(expr));
createAgentWorker([calcTool]); // Runs standard 7-turn ReAct reasoning loop
```

### 2. Custom Agent Topologies (Bypassing ReAct)
You can pass **any custom Runnable chain** directly into `createAgentWorker()`:
```javascript
import { RunnableSequence, RunnableLambda, createAgentWorker } from './prompt-chain-worker.js';

const directAnswerChain = RunnableSequence.from([
    new RunnableLambda(async ({ userPrompt, logToMain }) => {
        logToMain("Thought: Bypassing ReAct loop for linear execution...");
        return `Answer directly: ${userPrompt}`;
    }),
    myLLMRunnable // Any custom model wrapper or pipeline step
]);

createAgentWorker(directAnswerChain); // Universal Web Worker Host runs your chain!
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
