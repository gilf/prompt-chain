import { Tool, createAgentWorker } from './prompt-chain-worker.js';

// Define custom tools
const fetchTool = new Tool(
    "FetchData",
    "Fetches text content from a URL.",
    async (url) => {
        const res = await fetch(url);
        return await res.text();
    }
);

const mathTool = new Tool(
    "Calculator",
    "Evaluates math expressions (e.g. '100 * 5').",
    (expression) => {
        return String(eval(expression));
    }
);

// Initialize the generic engine with these specific tools
createAgentWorker([fetchTool, mathTool]);