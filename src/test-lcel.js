import { RunnableSequence, RunnableParallel, RunnableLambda, RunnablePassthrough } from './runnable.js';

async function runTests() {
    console.log("=== Testing LCEL Runnables ===");

    // Test 1: RunnableSequence
    const addOne = new RunnableLambda(x => x + 1);
    const double = new RunnableLambda(x => x * 2);
    const seq = addOne.pipe(double);
    const res1 = await seq.invoke(3);
    console.log(`Test 1 (Sequence 3 + 1 * 2): ${res1} (Expected: 8)`);
    if (res1 !== 8) throw new Error("Sequence test failed!");

    // Test 2: RunnableSequence.from
    const triple = new RunnableLambda(x => x * 3);
    const seqFrom = RunnableSequence.from([addOne, double, triple]);
    const res2 = await seqFrom.invoke(3); // (3+1)*2*3 = 24
    console.log(`Test 2 (Sequence.from): ${res2} (Expected: 24)`);
    if (res2 !== 24) throw new Error("Sequence.from test failed!");

    // Test 3: RunnableParallel
    const parallel = new RunnableParallel({
        added: addOne,
        doubled: double
    });
    const res3 = await parallel.invoke(10);
    console.log(`Test 3 (Parallel):`, JSON.stringify(res3), `(Expected: {"added":11,"doubled":20})`);
    if (res3.added !== 11 || res3.doubled !== 20) throw new Error("Parallel test failed!");

    // Test 4: RunnablePassthrough.assign
    const assignChain = RunnablePassthrough.assign({
        nextNumber: new RunnableLambda(obj => obj.val + 1)
    });
    const res4 = await assignChain.invoke({ val: 99 });
    console.log(`Test 4 (Passthrough.assign):`, JSON.stringify(res4), `(Expected: {"val":99,"nextNumber":100})`);
    if (res4.val !== 99 || res4.nextNumber !== 100) throw new Error("Passthrough.assign test failed!");

    console.log("=== ALL LCEL TESTS PASSED SUCCESSFULLY! ===");
}

runTests().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
