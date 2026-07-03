import { Tool, createAgentWorker, loadSkillFromUrl } from '../index.js';

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

const bookFlightTool = new Tool(
    "bookFlight",
    "Books a flight ticket between two cities for a given number of passengers.",
    async ({ origin, dest, passengers }) => {
        return `SUCCESS: Flight reserved from ${origin} to ${dest} for ${passengers} passenger(s). Ref: FL-9981.`;
    },
    {
        type: "object",
        properties: {
            origin: { type: "string", description: "Departure city airport code (e.g., NYC)" },
            dest: { type: "string", description: "Arrival city airport code (e.g., LAX)" },
            passengers: { type: "integer", description: "Number of passengers traveling" }
        },
        required: ["origin", "dest", "passengers"]
    },
    { requiresApproval: true }
);

const weatherSkill = await loadSkillFromUrl('../../skills/weather');
createAgentWorker([fetchTool, mathTool, bookFlightTool], [weatherSkill]);
