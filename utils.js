export function isRecoverableError(error) {
    const msg = error.message.toLowerCase();
    return (
        msg.includes("timeout") ||
        msg.includes("time out") ||
        msg.includes("fetch") ||
        msg.includes("network") ||
        msg.includes("http error") ||
        msg.includes("status 5") ||
        msg.includes("status 429") ||
        msg.includes("rate limit") ||
        error.name === "TimeoutError"
    );
}

export async function runWithTimeout(executeFn, input, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const err = new Error("Tool execution timed out.");
            err.name = "TimeoutError";
            reject(err);
        }, timeoutMs);

        Promise.resolve(executeFn(input))
            .then(result => {
                clearTimeout(timer);
                resolve(result);
            })
            .catch(err => {
                clearTimeout(timer);
                reject(err);
            });
    });
}

export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
