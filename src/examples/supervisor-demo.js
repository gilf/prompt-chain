import { Tool, StateGraph, START, END, createAgentSupervisor, createAgentWorker, RunnableLambda } from '../index.js';

// 1. Define specialized tools
const searchTool = new Tool(
    "SearchDocs", 
    "Searches internal project documentation and specs.", 
    async (query) => `Found doc snippet for '${query}': StateGraph and Supervisor primitives are supported in v0.1.1.`
);

const calcTool = new Tool(
    "Calculator", 
    "Evaluates mathematical expressions.", 
    (expr) => String(eval(expr))
);

// 2. Define specialized worker nodes (Runnables)
const researcherAgent = new RunnableLambda(async (state) => {
    const { userPrompt, logToMain } = state;
    logToMain("Action [Researcher]: Running SearchDocs tool...");
    const result = await searchTool.invoke(userPrompt);
    logToMain(`Observation [Researcher]: ${result}`);
    return { 
        messages: [`Researcher: ${result}`], 
        lastObservation: result 
    };
});

const mathAgent = new RunnableLambda(async (state) => {
    const { logToMain } = state;
    logToMain("Action [MathExpert]: Running Calculator tool on 542 * 13...");
    const result = await calcTool.invoke("542 * 13");
    logToMain(`Observation [MathExpert]: ${result}`);
    return { 
        messages: [`MathExpert: Calculated result is ${result}`], 
        finalAnswer: `The combined research analysis and calculated budget (542 * 13) is ${result}.` 
    };
});

// 3. Create the Supervisor Router
const supervisor = createAgentSupervisor({
    agents: [
        { name: "Researcher", description: "Searches documentation, guidelines, and web data" },
        { name: "MathExpert", description: "Performs numerical calculations and math evaluations" }
    ]
});

// 4. Build the StateGraph
const graph = new StateGraph({
    reducers: {
        messages: (old, add) => (old || []).concat(add)
    }
});

graph.addNode("supervisor", supervisor);
graph.addNode("Researcher", researcherAgent);
graph.addNode("MathExpert", mathAgent);

// 5. Define cyclical routing: Supervisor routes to worker or END; workers route back to Supervisor
graph.setEntryPoint("supervisor");
graph.addConditionalEdges("supervisor", (state) => state.next, {
    "Researcher": "Researcher",
    "MathExpert": "MathExpert",
    "FINISH": END
});

graph.addEdge("Researcher", "supervisor");
graph.addEdge("MathExpert", "supervisor");

const compiledSwarm = graph.compile();

// 6. Host inside Universal Web Worker Runtime!
createAgentWorker(compiledSwarm);
