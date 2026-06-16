export class Tool {
    constructor(name, description, executeFn) {
        this.name = name;
        this.description = description;
        this.executeFn = executeFn;
    }
}

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

class PromptTemplate {
    constructor() {
        this.systemInstruction = `You are an autonomous AI agent with long-term memory. Think step-by-step.
            You must STRICTLY output valid JSON matching the schema.
            
            Rules:
            1. If you need data, set "toolName" to a tool and "toolInput" to the query. Leave "finalAnswer" as "".
            2. If you know the answer, set "toolName" to "none" and put the answer in "finalAnswer".`;

        this.fewShotExamples = `
            --- Example 1: Using a Tool ---
            User: What is the current stock price of Apple?
            {"thought": "I need to look up the real-time stock price for Apple (AAPL).", "toolName": "FetchStockPrice", "toolInput": "AAPL", "finalAnswer": ""}
            Observation from FetchStockPrice: 175.50
            {"thought": "I have the observation. I can now provide the final answer.", "toolName": "none", "toolInput": "", "finalAnswer": "The current stock price of Apple is $175.50."}
            
            --- Example 2: Answering Directly ---
            User: What is the capital of France?
            {"thought": "I know the capital of France is Paris. No tool is needed.", "toolName": "none", "toolInput": "", "finalAnswer": "The capital of France is Paris."}
            `;
    }

    format(relevantTools, historyTurns, userPrompt) {
        const toolDescriptions = relevantTools.length > 0
            ? relevantTools.map(t => `- ${t.name}: ${t.description}`).join('\n')
            : "- none: No external tools available for this query.";

        return `${this.systemInstruction}           
            Available tools for this request:
            ${toolDescriptions}
            - none: Use this if you do not need a tool.
            
            ${this.fewShotExamples}
            
            --- Current Conversation ---
            Prior History:
            ${historyTurns.length > 0 ? historyTurns.join('\n') : "No prior history."}
            
            User: ${userPrompt}
            Output your next step as JSON:`;
    }
}

class ToolRetriever {
    constructor(toolsArray) {
        this.tools = toolsArray;
    }

    // A lightweight retrieval mechanism to find the top K relevant tools
    async getRelevantTools(userPrompt, topK = 3) {
        if (this.tools.length <= topK) return this.tools;

        const query = userPrompt.toLowerCase();

        // Score tools based on relevance to the prompt
        const scoredTools = this.tools.map(tool => {
            let score = 0;
            const targetText = (tool.name + " " + tool.description).toLowerCase();

            // Basic token overlap scoring (Simulating a BM25 or Embedding search)
            const queryTokens = query.split(/\W+/);
            for (const token of queryTokens) {
                if (token.length > 3 && targetText.includes(token)) {
                    score += 1;
                }
            }
            return { tool, score };
        });

        return scoredTools
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(st => st.tool);
    }
}

// --- Core Engine Factory ---
export function createAgentWorker(toolsArray) {
    let msgId = 0;
    const resolvers = new Map();

    const memory = new AgentMemory();
    const toolRetriever = new ToolRetriever(toolsArray);
    const promptTemplate = new PromptTemplate();

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

    // prompt-chain-worker.js (Updated runReActLoop)

    async function runReActLoop(userPrompt, sessionId) {
        let isComplete = false;
        let finalResult = "";
        let loopCount = 0;

        const historyTurns = await memory.getHistory(sessionId);
        const relevantTools = await toolRetriever.getRelevantTools(userPrompt, 3);
        const toolsMap = new Map(relevantTools.map(t => [t.name, t]));

        let currentTurnLog = `User: ${userPrompt}\n`;
        let currentPrompt = promptTemplate.format(relevantTools, historyTurns, userPrompt);

        while (!isComplete && loopCount < 7) {
            loopCount++;

            const responseText = await askLLM(currentPrompt);
            let response;

            try {
                response = JSON.parse(responseText);
            } catch (e) {
                currentPrompt = `Observation: Invalid JSON format received. You must respond strictly in JSON syntax.`;
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

                    currentTurnLog += `Action: ${response.toolName}("${response.toolInput}")\nObservation: ${toolResult}\n`;
                    logToMain(`Observation: ${toolResult}`);
                    currentPrompt = `Observation from ${response.toolName}: ${toolResult}\nGiven this observation, output your next step as JSON:`;

                } catch (err) {
                    currentTurnLog += `Observation: Tool failed with error: ${err.message}\n`;
                    currentPrompt = `Observation: Tool failed with error: ${err.message}\nGiven this observation, output your next step as JSON:`;
                }
            }
            else if (response.toolName === "none" || response.toolName === "") {
                currentPrompt = `Observation: You set toolName to "none" but omitted a finalAnswer. Provide your final answer text in the JSON.`;
            }
            else {
                currentPrompt = `Observation: Tool '${response.toolName}' is not loaded. Select from available tools or use 'none'.`;
            }
        }

        if (finalResult) {
            historyTurns.push(currentTurnLog.trim());
            if (historyTurns.length > 10) historyTurns.shift();
            await memory.saveHistory(sessionId, historyTurns);
        }

        return finalResult || "Error: Reached maximum iterations.";
    }

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
