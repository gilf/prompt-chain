export class BaseMessage {
    constructor(content, additional_kwargs = {}) {
        this.content = content;
        this.additional_kwargs = additional_kwargs;
    }

    getType() {
        throw new Error("Abstract method getType() must be implemented.");
    }

    toJSON() {
        return {
            type: this.getType(),
            content: this.content,
            additional_kwargs: this.additional_kwargs
        };
    }

    static fromJSON(data) {
        if (!data || typeof data !== "object") {
            return new HumanMessage(String(data || ""));
        }
        switch (data.type) {
            case "human":
                return new HumanMessage(data.content, data.additional_kwargs);
            case "ai":
                return new AIMessage(data.content, data.additional_kwargs);
            case "system":
                return new SystemMessage(data.content, data.additional_kwargs);
            case "tool":
                return new ToolMessage(
                    data.content,
                    data.additional_kwargs?.tool_name || data.additional_kwargs?.tool_call_id || "unknown_tool",
                    data.additional_kwargs
                );
            default:
                return new HumanMessage(data.content || JSON.stringify(data), data.additional_kwargs);
        }
    }
}

export class HumanMessage extends BaseMessage {
    getType() {
        return "human";
    }
}

export class AIMessage extends BaseMessage {
    constructor(content, additional_kwargs = {}) {
        super(content, additional_kwargs);
        this.tool_calls = additional_kwargs.tool_calls || [];
    }

    getType() {
        return "ai";
    }
}

export class SystemMessage extends BaseMessage {
    getType() {
        return "system";
    }
}

export class ToolMessage extends BaseMessage {
    constructor(content, tool_name, additional_kwargs = {}) {
        super(content, { ...additional_kwargs, tool_name });
        this.tool_name = tool_name;
    }

    getType() {
        return "tool";
    }
}
