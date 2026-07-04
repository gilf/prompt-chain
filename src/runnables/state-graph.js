import { Runnable, registerRunnableClasses } from './runnable.js';
import { RunnableLambda } from './runnable-lambda.js';
import { CallbackEvents } from '../consts.js';

export const START = "__START__";
export const END = "__END__";

export class StateGraph {
    constructor({ reducers = {}, defaultReducer = null } = {}) {
        this.nodes = new Map();
        this.edges = new Map();
        this.conditionalEdges = new Map();
        this.entryPoint = null;
        this.reducers = reducers;
        this.defaultReducer = defaultReducer || ((oldVal, newVal) => newVal);
    }

    addNode(nodeName, action) {
        if (nodeName === START || nodeName === END) {
            throw new Error(`Cannot add node with reserved name '${nodeName}'.`);
        }
        let runnable = action;
        if (!(runnable instanceof Runnable) && typeof runnable?.invoke !== "function") {
            if (typeof runnable === "function") {
                runnable = new RunnableLambda(runnable);
            } else {
                throw new Error(`Node action for '${nodeName}' must be a Runnable, function, or object with invoke().`);
            }
        }
        this.nodes.set(nodeName, runnable);
        return this;
    }

    addEdge(fromNode, toNode) {
        if (fromNode === START) {
            this.setEntryPoint(toNode);
            return this;
        }
        this.edges.set(fromNode, toNode);
        return this;
    }

    addConditionalEdges(fromNode, conditionFn, edgeMap = null) {
        if (typeof conditionFn !== "function" && !(conditionFn instanceof Runnable) && typeof conditionFn?.invoke !== "function") {
            throw new Error("Condition for conditional edges must be a function or Runnable.");
        }
        this.conditionalEdges.set(fromNode, { fn: conditionFn, map: edgeMap });
        return this;
    }

    setEntryPoint(nodeName) {
        this.entryPoint = nodeName;
        return this;
    }

    setFinishPoint(nodeName) {
        return this.addEdge(nodeName, END);
    }

    compile(options = {}) {
        if (!this.entryPoint) {
            throw new Error("StateGraph compilation failed: No entry point set. Use setEntryPoint() or addEdge(START, ...).");
        }
        if (!this.nodes.has(this.entryPoint)) {
            throw new Error(`StateGraph compilation failed: Entry point node '${this.entryPoint}' is not added.`);
        }
        for (const [from, to] of this.edges.entries()) {
            if (!this.nodes.has(from)) {
                throw new Error(`StateGraph compilation failed: Edge source node '${from}' does not exist.`);
            }
            if (to !== END && !this.nodes.has(to)) {
                throw new Error(`StateGraph compilation failed: Edge target node '${to}' does not exist.`);
            }
        }
        for (const [from, cond] of this.conditionalEdges.entries()) {
            if (!this.nodes.has(from)) {
                throw new Error(`StateGraph compilation failed: Conditional edge source '${from}' does not exist.`);
            }
            if (cond.map) {
                for (const target of Object.values(cond.map)) {
                    if (target !== END && target !== "FINISH" && !this.nodes.has(target)) {
                        throw new Error(`StateGraph compilation failed: Conditional target '${target}' does not exist.`);
                    }
                }
            }
        }
        return new CompiledStateGraph(
            new Map(this.nodes),
            new Map(this.edges),
            new Map(this.conditionalEdges),
            this.entryPoint,
            this.reducers,
            this.defaultReducer,
            options
        );
    }
}

export class CompiledStateGraph extends Runnable {
    constructor(nodes, edges, conditionalEdges, entryPoint, reducers, defaultReducer, options = {}) {
        super();
        this.nodes = nodes;
        this.edges = edges;
        this.conditionalEdges = conditionalEdges;
        this.entryPoint = entryPoint;
        this.reducers = reducers;
        this.defaultReducer = defaultReducer;
        this.maxIterations = options.maxIterations || 25;
    }

    _applyReducers(state, output) {
        if (!output || typeof output !== "object") return state;
        const newState = Object.assign({}, state);
        for (const [key, val] of Object.entries(output)) {
            if (val === undefined) continue;
            if (this.reducers && typeof this.reducers[key] === "function") {
                newState[key] = this.reducers[key](newState[key], val);
            } else if (typeof this.defaultReducer === "function") {
                newState[key] = this.defaultReducer(newState[key], val);
            } else {
                newState[key] = val;
            }
        }
        return newState;
    }

    async invoke(initialState, config = {}) {
        let state = typeof initialState === "object" && initialState !== null ? Object.assign({}, initialState) : { value: initialState };
        let currentNode = this.entryPoint;
        let iterations = 0;

        config.callbacks?.dispatch(CallbackEvents.graphStart || "on_graph_start", { entryPoint: currentNode, state });

        while (currentNode !== END && iterations < this.maxIterations) {
            iterations++;
            const nodeRunnable = this.nodes.get(currentNode);
            if (!nodeRunnable) {
                throw new Error(`CompiledStateGraph error: Node '${currentNode}' not found during execution.`);
            }

            config.callbacks?.dispatch(CallbackEvents.nodeStart || "on_node_start", { node: currentNode, state, iteration: iterations });

            let output;
            try {
                if (typeof nodeRunnable.invoke === "function") {
                    output = await nodeRunnable.invoke(state, config);
                } else if (typeof nodeRunnable === "function") {
                    output = await Promise.resolve(nodeRunnable(state, config));
                } else {
                    throw new Error(`Node '${currentNode}' cannot be invoked.`);
                }
            } catch (err) {
                throw err;
            }

            if (output && typeof output === "object" && output.interrupted) {
                return output;
            }

            state = this._applyReducers(state, output);
            config.callbacks?.dispatch(CallbackEvents.nodeEnd || "on_node_end", { node: currentNode, state, output });

            if (this.conditionalEdges.has(currentNode)) {
                const cond = this.conditionalEdges.get(currentNode);
                let condResult;
                if (typeof cond.fn?.invoke === "function") {
                    condResult = await cond.fn.invoke(state, config);
                } else if (typeof cond.fn === "function") {
                    condResult = await Promise.resolve(cond.fn(state, config));
                } else {
                    throw new Error(`Conditional function for node '${currentNode}' is invalid.`);
                }
                
                if (cond.map) {
                    if (condResult in cond.map) {
                        currentNode = cond.map[condResult];
                    } else if (condResult === "FINISH" || condResult === "__END__" || condResult === "END") {
                        currentNode = END;
                    } else {
                        throw new Error(`Conditional edge result '${condResult}' from node '${currentNode}' not found in edge map.`);
                    }
                } else {
                    currentNode = condResult;
                }
                if (currentNode === "FINISH" || currentNode === "__END__" || currentNode === "END") {
                    currentNode = END;
                }
            } else if (this.edges.has(currentNode)) {
                currentNode = this.edges.get(currentNode);
                if (currentNode === "FINISH" || currentNode === "__END__" || currentNode === "END") {
                    currentNode = END;
                }
            } else {
                currentNode = END;
            }

        }

        if (iterations >= this.maxIterations && currentNode !== END) {
            throw new Error(`CompiledStateGraph exceeded maximum iterations (${this.maxIterations}). Check for infinite loops or increase maxIterations.`);
        }

        config.callbacks?.dispatch(CallbackEvents.graphEnd || "on_graph_end", { state, iterations });
        return state;
    }
}

registerRunnableClasses({ StateGraph, CompiledStateGraph });
