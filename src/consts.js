export const MessageContext = {
    llmRequest: 'llm_request',
    llmStreamToken: 'llm_stream_token',
    llmResponse: 'llm_response',
    llmError: 'llm_error',
    agentLog: 'agent_log',
    agentCallbackEvent: 'agent_callback_event',
    agentComplete: 'agent_complete',
    agentError: 'agent_error',
    startLoop: 'start_loop'
};

export const CallbackEvents = {
    chainStart: 'on_chain_start',
    chainEnd: 'on_chain_end',
    llmStart: 'on_llm_start',
    llmNewToken: 'on_llm_new_token',
    llmEnd: 'on_llm_end',
    toolStart: 'on_tool_start',
    toolEnd: 'on_tool_end',
    toolError: 'on_tool_error',
    eventDispatch: 'agent_callback'
};