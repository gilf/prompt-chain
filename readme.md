# On-Device Prompt Chain Agent

An interactive, on-device AI agent platform that runs a **ReAct (Reasoning + Action)** loop inside a Web Worker. 
It leverages Chrome's experimental **built-in Gemini Prompt API** for private, local, and cost-free inference, combining custom tools, modular skills, and persistent long-term memory.

---

## Key Features

- **On-Device LLM Inference**: Runs entirely in the browser using Chrome's built-in `LanguageModel` API (`window.LanguageModel`), eliminating the need for external API keys or network latency.
- **Asynchronous Web Worker Architecture**: 
  - [prompt-chain-host.js](file:///c:/Lectures/Demo/prompt-chain-host.js) runs on the main browser thread to manage the LLM session.
  - [prompt-chain-worker.js](file:///c:/Lectures/Demo/prompt-chain-worker.js) runs in a background thread to orchestrate the agent loop, execute tools, and handle errors, keeping the user interface completely responsive.
- **Dynamic Skill & Tool Retrieval (Lightweight RAG)**: Matches the user prompt against loaded skills and tools using a token-overlap scorer, feeding only relevant context to the prompt and preserving token limits.
- **Long-term Memory with Auto-Summarization**: 
  - Uses [agent-memory.js](file:///c:/Lectures/Demo/agent-memory.js) to store conversation histories locally in the browser via **IndexedDB**.
  - Implements automatic conversation summarization (defined in [utils.js](file:///c:/Lectures/Demo/utils.js)) once the chat history exceeds 5 turns, ensuring the context window remains optimized.
- **Interactive UI Stream**: A sleek interface built with HTML/CSS that displays the real-time agent reasoning steps (Thoughts, Actions, and Observations) alongside the final response.

---

## File Directory & Architecture

- **[index.html](file:///c:/Lectures/Demo/index.html)** & **[styles.css](file:///c:/Lectures/Demo/styles.css)**: The frontend user interface containing input fields, suggestion chips, reasoning stream log viewports, and loaded skills indicators.
- **[my-agent.js](file:///c:/Lectures/Demo/my-agent.js)**: The Web Worker entry point. It instantiates the worker, defines global tools (like `Calculator` and `FetchData`), and loads dynamic skills.
- **[prompt-chain-worker.js](file:///c:/Lectures/Demo/prompt-chain-worker.js)**: The core ReAct loop manager. Parses LLM output JSON structure, calls tool execution logic, handles timeouts/retries, and updates IndexedDB.
- **[prompt-chain-host.js](file:///c:/Lectures/Demo/prompt-chain-host.js)**: Manages main thread events, initializes Chrome's built-in model, translates LLM requests from the worker, and dispatches log streams to the UI.
- **[prompt-template.js](file:///c:/Lectures/Demo/prompt-template.js)**: Assembles the prompt structure including system rules, few-shot examples, relevant tools, active skill instructions, and prior history summary.
- **[skills/](file:///c:/Lectures/Demo/skills)**:
  - **[weather/](file:///c:/Lectures/Demo/skills/weather)**: A sample modular skill containing:
    - **[SKILL.md](file:///c:/Lectures/Demo/skills/weather/SKILL.md)**: Markdown file containing attributes (YAML frontmatter) and system instructions.
    - **[tools.js](file:///c:/Lectures/Demo/skills/weather/tools.js)**: Local implementation of weather-fetching mock tools.

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
If you have Node.js installed, open a terminal in the project directory and run:
```bash
npx serve
```
Or:
```bash
npx http-server
```
Then navigate to the URL provided in the console (usually `http://localhost:3000` or `http://localhost:8080`).

### Option 2: Using Python
If you have Python installed, run the following command in your terminal:
```bash
python -m http.server 8000
```
Then open your browser and navigate to `http://localhost:8000`.

### Option 3: Using VS Code Live Server
If you are using Visual Studio Code, you can install the **Live Server** extension, open the project workspace, and click the **Go Live** button in the status bar.

---

## Usage Guide

1. Make sure your browser has the Prompt API enabled.
2. Launch the local server and open the page.
3. The page will display the **WeatherExpert** skill loaded in the sidebar.
4. Select one of the pre-defined suggestions (e.g., *Weather in Tokyo*) or type your own query.
5. Click **Run Agent**.
6. Follow the **Agent Reasoning Stream** to see the agent's thought process, how it chooses to execute the weather or math tools, and its final response.
