# GEMINI.md — Project Tech Stack, Development Rules & Context References

This document serves as the canonical reference and behavioral guide for AI agents and developers contributing to `@gilfink/prompt-chain`.

---

## 1. Project Overview & Philosophy

- **Package Name**: `@gilfink/prompt-chain` (`On-Device Prompt API Chain AI Agents`)
- **Core Mission**: A production-grade, zero-dependency ES6 library that brings enterprise-level AI agent orchestration directly to on-device browsers (`window.LanguageModel`), executing safely inside background Web Workers without main-thread UI freezing.
- **Zero Third-Party Usage (`Zero-Dependency Rule`)**:
  - The runtime library (`src/`) **must have ZERO external runtime dependencies** (`"dependencies": {}` in `package.json`).
  - Everything is built from scratch using pure ES6 modules and native Web APIs (`IndexedDB`, `Web Workers`, `Fetch API`, Chrome Prompt API `window.LanguageModel`).
  - Do not introduce NPM packages like `langchain`, `zod`, `axios`, or `@opentelemetry/sdk`. All enterprise capabilities (e.g., LCEL runnables, recursive JSON Schema validation, vector cosine similarity, OpenTelemetry OTLP tracing, and state graphs) are implemented natively within `src/`.

---

## 2. Project Tech Stack & Architecture

- **Language & Modules**: Modern ES6 JavaScript (`type: "module"`). All local imports must include explicit `.js` extensions (e.g., `import { BaseMessage } from "./messages.js"`).
- **Inference Engine**: Chrome Built-in AI (`window.LanguageModel`, `session.promptStreaming()`, `session.measureContextUsage()`). Supports hybrid local/cloud routing via `RunnableFallback`.
- **Build & Dev Tooling**:
  - `vite` (`^5.2.0`) for local development web server (`npm run dev`) and UMD/ESM library bundling (`npm run build`).
- **Asynchronous Web Worker Architecture**:
  - **`PromptChainHost` ([src/core/prompt-chain-host.js](file:///c:/Lectures/Demo/src/core/prompt-chain-host.js))**: Main UI thread session controller. Manages model readiness, event listeners (`CallbackManager`), and cross-thread message passing.
  - **`PromptChainWorker` ([src/core/prompt-chain-worker.js](file:///c:/Lectures/Demo/src/core/prompt-chain-worker.js))**: Background Web Worker runtime host. Orchestrates the 7-turn `ReActAgentExecutor` reasoning loop, executes multi-parameter structured tools, validates schemas, and runs custom LangChain Expression Language (LCEL) chains.
- **Persistent Local Storage & Universal Opener (`IndexedDB`)**:
  - **`openIndexedDB(dbName, requiredStores)` ([src/utils.js](file:///c:/Lectures/Demo/src/utils.js#L117-L170))**: The **Universal Database Migration Helper**. Always use this function to open IndexedDB databases. It opens the database without specifying a hardcoded version number (connecting cleanly to any existing version `v1`, `v2`, `v3`, etc. without `VersionError`), and dynamically upgrades (`db.version + 1`) only when new object stores are missing (`conversations`, `checkpoints`, `traces`, or `vectors`).
  - **`AgentMemory` ([src/core/agent-memory.js](file:///c:/Lectures/Demo/src/core/agent-memory.js))**: Stores object-oriented conversation histories (`HumanMessage`, `AIMessage`) and Human-in-the-Loop (HITL) checkpoints.
  - **`IndexedDBVectorStore` ([src/retrievers/indexeddb-vector-store.js](file:///c:/Lectures/Demo/src/retrievers/indexeddb-vector-store.js))**: Client-side vector database (`cosineSimilarity`) supporting semantic pruning for `SkillRetriever` and `ToolRetriever`.
  - **`IndexedDBTraceExporter` ([src/observability/exporters.js](file:///c:/Lectures/Demo/src/observability/exporters.js))**: Persists completed OpenTelemetry trace hierarchies locally (`AgentMemoryDB`, `traces` store).

---

## 3. Core Capabilities & Module Directory (`Context & Memory References`)

### LangChain Expression Language (LCEL) Runnables ([src/runnables/](file:///c:/Lectures/Demo/src/runnables))
- **Core Primitives**: [runnable.js](file:///c:/Lectures/Demo/src/runnables/runnable.js) (`.pipe()`, `.bind()`), [runnable-sequence.js](file:///c:/Lectures/Demo/src/runnables/runnable-sequence.js) (`RunnableSequence.from`), [runnable-parallel.js](file:///c:/Lectures/Demo/src/runnables/runnable-parallel.js) (`RunnableParallel`), [runnable-lambda.js](file:///c:/Lectures/Demo/src/runnables/runnable-lambda.js) (`RunnableLambda`), [runnable-passthrough.js](file:///c:/Lectures/Demo/src/runnables/runnable-passthrough.js) (`RunnablePassthrough.assign`).
- **`RunnableTokenBuffer` ([runnable-token-buffer.js](file:///c:/Lectures/Demo/src/runnables/runnable-token-buffer.js))**: Watermark context window monitoring (default 85%). Automatically truncates lengthy tool observations (`pruneObservation`) and summarizes rolling turn history (`session.measureContextUsage()`).
- **`RunnableInterrupt` ([runnable-interrupt.js](file:///c:/Lectures/Demo/src/runnables/runnable-interrupt.js))**: Human-in-the-Loop (HITL) safety rail. Suspends execution before running tools flagged with `{ requiresApproval: true }`, serializes exact state to IndexedDB (`checkpoints`), and emits `userApprovalRequired` to the UI.
- **`RunnableFallback` ([runnable-fallback.js](file:///c:/Lectures/Demo/src/runnables/runnable-fallback.js))**: Readiness monitoring (`modelDownloadProgress`) and hybrid local/cloud retry routing (`[localLLM, cloudFallbackLLM]`).
- **`StructuredOutputRunnable` ([structured-output-runnable.js](file:///c:/Lectures/Demo/src/runnables/structured-output-runnable.js) & [validate-json-schema.js](file:///c:/Lectures/Demo/src/runnables/validate-json-schema.js))**: Zero-dependency recursive JSON Schema validator. Produces exact JSON pointer error paths (e.g., `Error at /toolInput/passengers: expected number, got string`) and automatically injects them into ReAct self-correction loops.
- **`RunnableRetriever` ([runnable-retriever.js](file:///c:/Lectures/Demo/src/runnables/runnable-retriever.js))**: Declarative LCEL vector RAG pipeline component.

### Multi-Agent Swarms & State Graphs ([src/runnables/state-graph.js](file:///c:/Lectures/Demo/src/runnables/state-graph.js) & [agent-supervisor.js](file:///c:/Lectures/Demo/src/runnables/agent-supervisor.js))
- **`StateGraph` & `CompiledStateGraph`**: LangGraph-style cyclical execution graphs with conditional routing (`addConditionalEdges`), entry/finish points (`START`, `END`), and custom channel reducers (e.g., `messages: (old, add) => old.concat(add)`).
- **`AgentSupervisor` (`createAgentSupervisor`)**: LLM-powered multi-agent supervisor router using strict JSON schema output enforcement to dynamically delegate tasks across specialized worker runnables (e.g., `Researcher` + `MathExpert`).

### Enterprise Observability & OpenTelemetry Tracing ([src/observability/](file:///c:/Lectures/Demo/src/observability))
- **`Trace`, `Span`, `SpanStatus` ([trace.js](file:///c:/Lectures/Demo/src/observability/trace.js))**: Hierarchical parent-child span trees (`parentSpanId`) with 16-char / 32-char hex ID generation (`generateHexId`), timestamps, execution durations (`durationMs`), status codes (`OK` / `ERROR`), and attributes (`Map`). Exports directly to standard **OpenTelemetry OTLP JSON Schema v1 (`toOTLP()`)**.
- **`Tracer` ([tracer.js](file:///c:/Lectures/Demo/src/observability/tracer.js))**: Active span stack manager (`activeSpanStack`). Automatically pushes/pops parent spans across execution blocks (`startSpan`, `endCurrentSpan`).
- **Standardized Exporters ([exporters.js](file:///c:/Lectures/Demo/src/observability/exporters.js))**:
  - `ConsoleTraceExporter`: Styled ASCII tree hierarchy logs in DevTools (`console.groupCollapsed`).
  - `IndexedDBTraceExporter`: Local persistence across sessions (`AgentMemoryDB` v2, `traces` store).
  - `OTLPTraceExporter`: Exports OTLP JSON via `fetch()` to HTTP endpoints (`http://localhost:4318/v1/traces`).
- **Interactive Trace Explorer UI ([index.html](file:///c:/Lectures/Demo/index.html) & [styles.css](file:///c:/Lectures/Demo/styles.css))**: Real-time trace cards with status badges, expandable parent-child span trees, and one-click OTLP JSON downloads.

---

## 4. Development & Operational Rules

### 1. Automated Verification Suite
Whenever making source code modifications or introducing new runnables/features, verify zero regressions by running the comprehensive Node.js test scripts inside `/tests`:
```bash
node ./tests/test-lcel.js              # Verifies sequential, parallel, lambda, & passthrough assignment chains
node ./tests/test-state-graph.js       # Verifies cyclical state graphs, conditional routing, & supervisor swarms
node ./tests/test-tracing.js           # Verifies OpenTelemetry trace trees, span stacks, & OTLP JSON export
node ./tests/test-structured-output.js # Verifies JSON Schema validation & ReAct self-repair pointers
node ./tests/test-vector-rag.js        # Verifies IndexedDB cosine similarity & semantic retrieval
node ./tests/test-fallback.js          # Verifies hybrid routing & self-correction retry limits
node ./tests/test-hitl.js              # Verifies checkpoint serialization & interruption resumption
node ./tests/test-token-buffer.js      # Verifies watermark observation pruning & rolling summarization
```
Ensure all relevant test suites pass with **0 failures** before completing a task.

### 2. Code Integrity & Tool Usage Guidelines
- **Preserve Documentation**: Never remove or overwrite existing docstrings, architecture explanations, or unrelated comments unless explicitly requested.
- **Specific Tool Priority**: Use specific tools (`replace_file_content`, `multi_replace_file_content`, `view_file`, `grep_search`) over generic terminal commands (`cat`, `sed`, `grep`). Never use `cat` inside a bash command to create or modify files.
- **IndexedDB Migrations**: Never pass a hardcoded integer version (e.g., `indexedDB.open(dbName, 2)`) inside initialization logic. Always use `openIndexedDB(dbName, requiredStores)` from `src/utils.js` to ensure backward/forward version compatibility across tabs and browser upgrades.

### 3. Chrome Experimental Flags Setup (For Testing Built-in AI)
To run the browser application locally with Chrome's native `window.LanguageModel`:
1. Navigate to `chrome://flags/#optimization-guide-on-device-model` -> **Enabled BypassPrefRequirement**.
2. Navigate to `chrome://flags/#prompt-api-for-gemini-nano` -> **Enabled**.
3. Relaunch Chrome and start the local development server using `npm run dev` (or `npx serve`).
