/**
 * Core LangChain Expression Language (LCEL) Primitives
 */

let RunnableLambdaClass = null;
let RunnableSequenceClass = null;
let RunnableBindingClass = null;

export function registerRunnableClasses({ RunnableLambda, RunnableSequence, RunnableBinding }) {
    if (RunnableLambda) RunnableLambdaClass = RunnableLambda;
    if (RunnableSequence) RunnableSequenceClass = RunnableSequence;
    if (RunnableBinding) RunnableBindingClass = RunnableBinding;
}

export class Runnable {
    async invoke(input, config = {}) {
        throw new Error("Abstract method invoke() must be implemented.");
    }

    pipe(nextRunnable) {
        if (!RunnableSequenceClass || !RunnableLambdaClass) {
            throw new Error("Runnable subclasses not registered. Ensure runnables/index.js or subclass modules are imported.");
        }
        if (typeof nextRunnable === "function") {
            nextRunnable = new RunnableLambdaClass(nextRunnable);
        }
        return new RunnableSequenceClass(this, nextRunnable);
    }

    bind(kwargs) {
        if (!RunnableBindingClass) {
            throw new Error("RunnableBinding not registered. Ensure runnables/index.js or subclass modules are imported.");
        }
        return new RunnableBindingClass(this, kwargs);
    }
}
