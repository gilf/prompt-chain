export class InterruptException extends Error {
    constructor(payload) {
        const msg = typeof payload === 'string' ? payload : (payload?.toolName ? `Interrupted for approval: ${payload.toolName}` : "Execution interrupted");
        super(msg);
        this.name = "InterruptException";
        this.payload = payload;
    }
}
