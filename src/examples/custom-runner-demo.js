import { RunnableSequence, RunnableLambda, createAgentWorker } from '../core/prompt-chain-worker.js';

/**
 * Demonstration: A Custom Linear QA Agent Topology (No ReAct Loop!)
 * 
 * Instead of passing an array of tools, we pass any LCEL Runnable chain
 * directly into createAgentWorker().
 */
const customLinearAgent = RunnableSequence.from([
    new RunnableLambda(async ({ userPrompt, logToMain }) => {
        logToMain(`Thought: Received user prompt "${userPrompt}". Bypassing standard ReAct loop...`);
        return `Please answer this directly and clearly in 2 sentences: ${userPrompt}`;
    }),
    new RunnableLambda(async () => {
        return `Mock Answer: Successfully executed custom linear agent pipeline for query!`;
    })
]);

createAgentWorker(customLinearAgent);
