// prompt-chain-worker.js

export class Tool {
    constructor(name, description, executeFn) {
        this.name = name;
        this.description = description;
        this.executeFn = executeFn;
    }
}

// --- IndexedDB Memory Layer ---
class AgentMemory {
    constructor(dbName = "AgentMemoryDB", storeName = "conversations") {
        this.dbName = dbName;
        this.storeName = storeName;
        this.db = null;
    }

    init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    // Keyed by sessionId (e.g., "session_123")
                    db.createObjectStore(this.storeName, { keyPath: "sessionId" });
                }
            };

            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve();
            };

            request.onerror = (e) => reject(e.target.error);
        });
    }

    getHistory(sessionId) {
        return new Promise((resolve) => {
            const tx = this.db.transaction(this.storeName, "readonly");
            const store = tx.objectStore(this.storeName);
            const request = store.get(sessionId);

            request.onsuccess = () => {
                resolve(request.result ? request.result.history : []);
            };
            request.onerror = () => resolve([]);
        });
    }

    saveHistory(sessionId, history) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, "readwrite");
            const store = tx.objectStore(this.storeName);
            const request = store.put({ sessionId, history });

            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }
}

// --- Core Engine Factory ---
export function createAgentWorker(toolsArray) {
    let msgId = 0;
    const resolvers = new Map();
    const toolsMap = new Map(toolsArray.map(t => [t.name, t]));
    const memory = new AgentMemory();

    const agentSchema = {
        "type": "object",
        "properties": {
            "thought": { "type": "string" },
            "toolName": { "type": "string" },
            "toolInput": { "type": "string" },
            "finalAnswer": { "type": "string" }
        },
        "required": ["thought", "toolName", "toolInput", "finalAnswer"]
    };

    function askLLM(prompt) {
        return new Promise((resolve, reject) => {
            const id = ++msgId;
            resolvers.set(id, { resolve, reject });
            self.postMessage({ id, type: 'llm_request', payload: { prompt, schema: agentSchema } });
        });
    }

    function logToMain(message) {
        self.postMessage({ id: 0, type: 'agent_log', payload: message });
    }

    async function runReActLoop(userPrompt, sessionId) {
        let isComplete = false;
        let finalResult = "";
        let loopCount = 0;

        // Load historical turns from IndexedDB entirely in the background
        const historyTurns = await memory.getHistory(sessionId);

        const toolDescriptions = toolsArray.map(t => `- ${t.name}: ${t.description}`).join('\n');

        // Inject instructions, available tools, and historical conversation
        let context = `System: You are an AI agent with long-term memory. Think step-by-step.
Available tools:
${toolDescriptions}
- none: Use this if you do not need a tool and can answer the user directly.

Rules:
1. If you need data, set "toolName" to a tool and "toolInput" to the query. Leave "finalAnswer" as "".
2. If you know the answer, set "toolName" to "none" and put the answer in "finalAnswer".

Prior Conversation History:
${historyTurns.length > 0 ? historyTurns.join('\n') : "No prior history."}

Current Turn:
User: ${userPrompt}\n`;

        // Local turn buffer to record the ongoing ReAct execution sequence
        let currentTurnLog = `User: ${userPrompt}\n`;

        while (!isComplete && loopCount < 7) {
            loopCount++;

            const responseText = await askLLM(`${context}\nOutput your next step as JSON:`);
            let response;

            try {
                response = JSON.parse(responseText);
            } catch (e) {
                context += `Observation: Invalid JSON format. Please output strictly valid JSON.\n`;
                continue;
            }

            if (response.thought) {
                logToMain(`Thought: ${response.thought}`);
                currentTurnLog += `Thought: ${response.thought}\n`;
            }

            if (response.finalAnswer && response.finalAnswer.trim() !== "") {
                finalResult = response.finalAnswer;
                currentTurnLog += `Assistant: ${response.finalAnswer}\n`;
                isComplete = true;
            }
            else if (response.toolName && response.toolName !== "none" && toolsMap.has(response.toolName)) {
                logToMain(`Action: Running ${response.toolName} with input "${response.toolInput}"`);

                try {
                    const tool = toolsMap.get(response.toolName);
                    const toolResult = await tool.executeFn(response.toolInput);

                    const actionStr = `Action: ${response.toolName}("${response.toolInput}")\nObservation: ${toolResult}\n`;
                    context += actionStr;
                    currentTurnLog += actionStr;

                    logToMain(`Observation: ${toolResult}`);
                } catch (err) {
                    context += `Observation: Tool failed with error: ${err.message}\n`;
                }
            }
            else if (response.toolName === "none" || response.toolName === "") {
                context += `Observation: You selected no tools, but didn't provide a finalAnswer. Please provide the final answer.\n`;
            }
            else {
                context += `Observation: Tool '${response.toolName}' does not exist. Use an available tool or 'none'.\n`;
            }
        }

        // Persist updated history back to IndexedDB before wrapping up
        if (finalResult) {
            historyTurns.push(currentTurnLog.trim());
            // Optional: keep the sliding window under control (e.g., last 10 full turns)
            if (historyTurns.length > 10) historyTurns.shift();
            await memory.saveHistory(sessionId, historyTurns);
        }

        return finalResult || "Error: Reached maximum iterations.";
    }

    // Handle incoming commands
    self.addEventListener('message', async (e) => {
        const { id, type, payload } = e.data;

        if (type === 'llm_response') {
            resolvers.get(id)?.resolve(payload);
            resolvers.delete(id);
        } else if (type === 'llm_error') {
            resolvers.get(id)?.reject(new Error(payload));
            resolvers.delete(id);
        } else if (type === 'start_loop') {
            try {
                // Ensure IndexedDB is initialized before running the ReAct loop
                await memory.init();
                const answer = await runReActLoop(payload.userPrompt, payload.sessionId);
                self.postMessage({ id, type: 'agent_complete', payload: answer });
            } catch (err) {
                self.postMessage({ id, type: 'agent_error', payload: err.message });
            }
        }
    });
}
