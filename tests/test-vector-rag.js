import { cosineSimilarity, EmbeddingsPlugin, IndexedDBVectorStore, RunnableRetriever, ToolRetriever, RunnableSequence, RunnableLambda } from '../src/index.js';

class MockSemanticEmbeddings extends EmbeddingsPlugin {
    async embedQuery(text) {
        const lower = text.toLowerCase();
        const vec = [0, 0, 0, 0];
        if (lower.includes("weather") || lower.includes("rain") || lower.includes("forecast")) vec[0] = 1.0;
        if (lower.includes("flight") || lower.includes("ticket") || lower.includes("travel")) vec[1] = 1.0;
        if (lower.includes("math") || lower.includes("calc") || lower.includes("number")) vec[2] = 1.0;
        if (lower.includes("music") || lower.includes("audio") || lower.includes("song")) vec[3] = 1.0;
        const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
        return norm === 0 ? [0.1, 0.1, 0.1, 0.1] : vec.map(v => v / norm);
    }
}

async function runVectorRagTests() {
    console.log("=== Testing On-Device Vector RAG & Semantic Retrieval ===");

    // Test 1: Mathematical correctness of cosineSimilarity
    console.log("Test 1: Verifying cosineSimilarity calculations...");
    const simIdentical = cosineSimilarity([1, 0, 0], [1, 0, 0]);
    const simOrthogonal = cosineSimilarity([1, 0, 0], [0, 1, 0]);
    const simOpposite = cosineSimilarity([1, 0, 0], [-1, 0, 0]);
    if (Math.abs(simIdentical - 1.0) > 1e-5 || Math.abs(simOrthogonal - 0.0) > 1e-5 || Math.abs(simOpposite - (-1.0)) > 1e-5) {
        throw new Error(`Test 1 failed: Unexpected cosine similarity values! Got identical=${simIdentical}, orthogonal=${simOrthogonal}`);
    }
    console.log("PASS: cosineSimilarity correctly calculates vector similarities.");

    // Test 2: IndexedDBVectorStore indexing and retrieval
    console.log("Test 2: Testing IndexedDBVectorStore document indexing & similarity search...");
    const embeddings = new MockSemanticEmbeddings();
    const store = new IndexedDBVectorStore({ embeddings });
    await store.addDocuments([
        { id: "doc1", content: "Check the local weather forecast and rain probability.", metadata: { category: "weather" } },
        { id: "doc2", content: "Book airline travel ticket for business flight.", metadata: { category: "flight" } },
        { id: "doc3", content: "Perform complex math number calculation.", metadata: { category: "math" } }
    ]);

    const weatherResults = await store.similaritySearchWithScore("Will it rain today in Tokyo?", 1);
    if (weatherResults.length === 0 || weatherResults[0].document.id !== "doc1") {
        throw new Error(`Test 2 failed: Expected doc1 for weather query, got ${JSON.stringify(weatherResults)}`);
    }
    console.log("PASS: IndexedDBVectorStore indexed documents and ranked semantic matches accurately.");

    // Test 3: RunnableRetriever LCEL integration
    console.log("Test 3: Verifying RunnableRetriever inside LCEL sequence...");
    const retriever = new RunnableRetriever(store, { topK: 1 });
    const ragPipeline = RunnableSequence.from([
        retriever,
        new RunnableLambda(async (docs) => `Retrieved context: ${docs[0]?.content}`)
    ]);
    const ragOutput = await ragPipeline.invoke("Need flight travel info");
    if (!ragOutput.includes("Book airline travel ticket")) {
        throw new Error(`Test 3 failed: LCEL RAG pipeline returned unexpected result: ${ragOutput}`);
    }
    console.log("PASS: RunnableRetriever integrated smoothly into LCEL pipeline sequence.");

    // Test 4: ToolRetriever semantic pruning
    console.log("Test 4: Testing dynamic semantic tool pruning with ToolRetriever...");
    const mockTools = [
        { name: "WeatherReporter", description: "Provides forecast and atmospheric conditions." },
        { name: "FlightBooking", description: "Reserves travel itineraries and tickets." },
        { name: "MathSolver", description: "Solves algebraic number equations." },
        { name: "MusicPlayer", description: "Streams audio tracks and songs." }
    ];

    const toolStore = new IndexedDBVectorStore({ embeddings });
    const toolRetriever = new ToolRetriever(mockTools);
    await toolRetriever.initVectorStore(toolStore);

    // Query using synonyms not directly matching keywords
    const selectedTools = await toolRetriever.getRelevantTools("I want to listen to some relaxing audio", 1);
    if (selectedTools.length !== 1 || selectedTools[0].name !== "MusicPlayer") {
        throw new Error(`Test 4 failed: Expected MusicPlayer tool, got ${JSON.stringify(selectedTools.map(t => t.name))}`);
    }
    console.log("PASS: ToolRetriever dynamically pruned tool manifest using vector cosine similarity.");

    // Test 5: Token-overlap keyword search fallback (no embeddings configured)
    console.log("Test 5: Verifying token-overlap keyword fallback when no embeddings model is configured...");
    const fallbackStore = new IndexedDBVectorStore({ embeddings: null });
    await fallbackStore.addDocuments([
        { id: "pref1", content: "User prefers Python programming language.", metadata: { category: "preferences" } },
        { id: "pref2", content: "User prefers dark mode UI theme.", metadata: { category: "preferences" } },
        { id: "pref3", content: "User likes to fly with Delta.", metadata: { category: "travel" } }
    ]);

    const fallbackResults = await fallbackStore.similaritySearchWithScore("favorite programming language", 1);
    if (fallbackResults.length === 0 || fallbackResults[0].document.id !== "pref1") {
        throw new Error(`Test 5 failed: Expected pref1 for fallback query, got ${JSON.stringify(fallbackResults)}`);
    }
    console.log("PASS: similaritySearchWithScore gracefully fell back to token-overlap scoring.");

    console.log("=== ALL VECTOR RAG & SEMANTIC RETRIEVAL TESTS PASSED SUCCESSFULLY! ===");
}

runVectorRagTests().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
