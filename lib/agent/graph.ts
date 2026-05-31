// V2 Step 23.3b — LangGraph Agent 状态图(生产)
//
// 不自带 server-only,对齐 lib/agent/tools.ts 范式:依赖链单向传染
// (tools.ts → lib/rag/embed + lib/supabase/admin → server-only),
// 任何 client 误 import 会在依赖链上抛错。
//
// ⚠️ 三坑修法(spike 已验证,硬约束,不要改)——
// 坑 1:ChatOpenAI 不设 streaming: true
//   SiliconFlow + LangChain 1.x 在 streaming: true 下不自动聚合
//   tool_call_chunks → tool_calls,导致 shouldContinue 看到空 tool_calls 直接 END、
//   工具节点不执行。callModel 内手动 llm.stream() + concat 聚合,聚合后的 chunk
//   自带完整 tool_calls 供路由,同时 LangChain on_chat_model_stream 回调照常触发
//   → LangGraph messages 模式仍能捕获逐 token 流给 route.ts 桥接。
// 坑 2:shouldContinue 必须同时判 AIMessage || AIMessageChunk
//   AIMessageChunk 不 extends AIMessage,走 BaseMessageChunk 平行链。
//   只判 AIMessage 会漏掉手动聚合后的 chunk → 永远走 END、工具永远不执行。

import {
  StateGraph,
  MessagesAnnotation,
  START,
  END,
} from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { makeSearchKnowledgeBaseTool } from './tools';

/**
 * 创建一个绑定了 tenantId 的 Agent 状态图。
 *
 * @param tenantId  租户 ID,通过工厂闭包注入 search_knowledge_base 工具,LLM 不可见。
 */
export function makeAgentGraph(tenantId: string) {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  const baseURL = process.env.SILICONFLOW_BASE_URL;
  if (!apiKey) throw new Error('缺少环境变量 SILICONFLOW_API_KEY');
  if (!baseURL) throw new Error('缺少环境变量 SILICONFLOW_BASE_URL');

  const tools = [makeSearchKnowledgeBaseTool(tenantId)];

  // 坑 1:绝不设 streaming: true
  const llm = new ChatOpenAI({
    model: 'deepseek-ai/DeepSeek-V3',
    apiKey,
    configuration: { baseURL },
  }).bindTools(tools);

  async function callModel(state: typeof MessagesAnnotation.State) {
    // 坑 1:手动 llm.stream() + concat 聚合 chunks。
    // 聚合后的 chunk 同时供:① shouldContinue 读 tool_calls 路由 ② messages 模式上游
    // 仍然逐 token 透出(LangChain on_chat_model_stream 回调在底层 stream 时触发)
    const stream = await llm.stream(state.messages);
    let aggregated: AIMessageChunk | undefined;
    for await (const chunk of stream) {
      aggregated = aggregated
        ? (aggregated.concat(chunk) as AIMessageChunk)
        : chunk;
    }
    if (!aggregated) throw new Error('LLM 没有输出 chunks');
    return { messages: [aggregated] };
  }

  function shouldContinue(state: typeof MessagesAnnotation.State) {
    const last = state.messages.at(-1);
    // 坑 2:|| 同时判,不能只判 AIMessage
    if (
      (last instanceof AIMessage || last instanceof AIMessageChunk) &&
      (last.tool_calls?.length ?? 0) > 0
    ) {
      return 'tools';
    }
    return END;
  }

  return new StateGraph(MessagesAnnotation)
    .addNode('agent', callModel)
    .addNode('tools', new ToolNode(tools))
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue)
    .addEdge('tools', 'agent')
    .compile();
}
