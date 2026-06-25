import { Tool, createAgentWorker, loadSkillFromUrl } from './index.js';

const fetchTool = new Tool(
    "FetchData",
    "Fetches text content from a URL.",
    async (url) => {
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`HTTP Error: status ${res.status}`);
        }
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

const weatherSkill = await loadSkillFromUrl('../skills/weather');
createAgentWorker([fetchTool, mathTool], [weatherSkill]);