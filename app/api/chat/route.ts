import { createDataStreamResponse, formatDataStreamPart } from 'ai';
import { z } from 'zod';
import type { JSONValue } from 'ai';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { GraphRecursionError } from '@langchain/langgraph';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeAgentGraph } from '@/lib/agent/graph';
import type { CollectedChunk } from '@/lib/agent/tools';
// Step 27.5.1:isRefusalText / REFUSAL_PATTERN_A/B 抽到 lib/agent/refusal.ts,
// SYSTEM_PROMPT 抽到 lib/agent/prompt.ts;共享给 spike 与评估脚本,本文件改 import 复用同一份。
import { isRefusalText } from '@/lib/agent/refusal';
import { SYSTEM_PROMPT } from '@/lib/agent/prompt';

export const runtime = 'nodejs';
// Vercel Hobby 默认 10s,流式对话偶尔长一点也更稳
export const maxDuration = 60;

// ---------- zod 入参校验 ----------
const MessageSchema = z
  .object({
    role: z.string(),
    content: z.unknown(),
  })
  .passthrough();

const ChatRequestSchema = z.object({
  messages: z.array(MessageSchema).min(1),
  tenantId: z.string().uuid('tenantId 必须是合法 UUID'),
  sessionId: z.string().uuid().optional(),
  visitorId: z.string().min(1).optional(),
});

// ---------- Citation 类型 ----------
interface Citation {
  [key: string]: unknown;
  index: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  similarity: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------- POST handler ----------
export async function POST(request: Request) {
  // 1. 解析并校验请求体
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('请求体不是合法 JSON', { status: 400 });
  }

  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      parsed.error.issues[0]?.message ?? '参数错误',
      { status: 400 },
    );
  }
  const { messages, tenantId, sessionId, visitorId } = parsed.data;

  // 2. B/C 端判定
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isOwner = Boolean(user && user.id === tenantId);

  if (!isOwner && !visitorId) {
    return new Response(
      'C 端匿名模式需要提供 visitorId',
      { status: 400 },
    );
  }

  // C 端速率限制(实现见 lib/rate-limit.ts,与 /api/chat/history 共享键空间)
  if (!isOwner && visitorId) {
    if (!checkRateLimit(visitorId)) {
      return new Response(
        JSON.stringify({ error: '请求过于频繁,请稍后再试' }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  // 3. 取最后一条 user 消息作为 query
  // V1 用 query 喂同步 retrieveContext;V2 Agent 自己从 messages 历史决定检索什么 query。
  // 这里 query 仅用于 chat_messages.user.content 写库(记录用户原句,无关 Agent 内部 query 改写)。
  const rawMessages = messages as Array<{ role: string; content: unknown }>;
  const lastUserMsg = [...rawMessages]
    .reverse()
    .find((m) => m.role === 'user');

  if (!lastUserMsg || typeof lastUserMsg.content !== 'string' || !lastUserMsg.content.trim()) {
    return new Response('消息列表中没有有效的用户消息', { status: 400 });
  }
  const query = lastUserMsg.content.trim();

  // 4. 建 session(若无)
  const admin = createAdminClient();
  let sid = sessionId;
  if (!sid) {
    const { data: sessionData, error: sessionErr } = await admin
      .from('chat_sessions')
      .insert({
        user_id: tenantId,
        visitor_id: isOwner ? 'playground' : visitorId!,
      })
      .select('id')
      .single();

    if (sessionErr || !sessionData) {
      console.error('[chat] 创建会话失败:', sessionErr);
      return new Response('创建会话失败', { status: 500 });
    }
    sid = sessionData.id as string;
  }

  // finalSid 供 execute 闭包使用(TypeScript 确认非 undefined)
  const finalSid = sid;

  // 5. 构造 V2 Agent graph(tenantId/sessionId 闭包注入工具,LLM 不可见)
  //    Step 23.3c 路径 β:graph 内部 new collector,工具闭包 push,
  //    route.ts 流跑完读 collector 做"去重 + 重编号 + 拒答清洗"
  //    Step 24.2:finalSid 透传给 escalate_to_human 用于写 role='system' 的
  //    ESCALATION 记录。chat_messages 无 user_id 列(主题 6.2),隔离只能靠
  //    sessionId 间接做,所以这里必须传 route.ts 已校验的 finalSid(LLM 不可见)。
  const { graph, collector } = makeAgentGraph(tenantId, finalSid);

  // 6. 把 ai-sdk 风格 messages 转 LangChain BaseMessage,顶部 prepend SystemMessage
  const langchainMessages: BaseMessage[] = [new SystemMessage(SYSTEM_PROMPT)];
  for (const m of rawMessages) {
    const content =
      typeof m.content === 'string' ? m.content : String(m.content ?? '');
    if (m.role === 'assistant') {
      langchainMessages.push(new AIMessage(content));
    } else {
      // V1 客户端 useChat 只发 user / assistant;其他 role 兜底为 HumanMessage
      langchainMessages.push(new HumanMessage(content));
    }
  }

  // 7. 流式响应:LangGraph → ai-sdk v4 dataStream 桥接(Step 23.3-spike 锁定写法)
  return createDataStreamResponse({
    execute: async (dataStream) => {
      // 先把 sessionId 推给前端(useChat experimental_prepareRequestBody 从 data part 抓取)
      dataStream.writeData({
        type: 'session',
        sessionId: finalSid,
      } as unknown as JSONValue);

      // Step 25.1b 层 3 准备:wall-clock 50s 超时 + signal 透传给 graph.stream
      // - 50s < Vercel maxDuration 60s(主题 8.2),留 10s 给 collector 聚合 + 拒答清洗
      //   + 写库 + 推 citations 收尾;finally clearTimeout 防泄漏
      // - 25.1a-spike T2 实证:graph.stream(input, config) 的 config 认 signal 字段,
      //   abort 后 for-await-of 抛 DOMException(name='AbortError')
      // - recursionLimit:10 兜底失控循环(25.1a-spike T1 实证:超限抛 GraphRecursionError,
      //   lc_error_code='GRAPH_RECURSION_LIMIT',minify-safe)
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 50_000);

      let fullText = '';
      // Step 27.2:同一 tool_call_id 只推一次 tool_status:start
      // - 27.1/27.2 spike 实测:LangChain 1.x 聚合后,每个 phase 只有 1 个 agent chunk 含 tool_calls
      // - 加最小防御性 dedup 兜底未来聚合实现变化,避免前端状态条闪烁(主题 16.3 精神)
      // - phase=end 不去重:每个 ToolMessage 一次,按 tool_call_id 自然唯一
      const toolStatusSeen = new Set<string>();
      try {
        for await (const chunk of await graph.stream(
          { messages: langchainMessages },
          {
            streamMode: 'messages',
            recursionLimit: 10,
            signal: abortController.signal,
          },
        )) {
          if (!Array.isArray(chunk) || chunk.length < 2) continue;
          const [msg, metadata] = chunk;
          // spike 坑 3 心法:agent 节点 + content 非空 = 最终回答 token
          // 自动排除:tools 节点输出、step=1 的 tool_call 增量流(content 全空)
          const node = isRecord(metadata) ? metadata.langgraph_node : undefined;

          // Step 27.2:② 源 tool_status:start — LLM 决定调工具的瞬间(content 空、tool_calls 非空)
          // - 27.2 spike 实测 t_toolcall=1517ms,比 ③ 源 t_toolmsg=3470ms 早 1953ms
          // - 这条 chunk 是 content 空的 tool_call 增量,提前 continue 等价于被现役 `if (!text) continue` 丢弃,
          //   text 流回答完整性零影响(命中条件 tool_calls.length>0,最终回答 token chunk 不命中)
          if (
            node === 'agent'
            && (msg instanceof AIMessage || msg instanceof AIMessageChunk)
            && Array.isArray(msg.tool_calls)
            && msg.tool_calls.length > 0
          ) {
            for (const tc of msg.tool_calls) {
              if (!isRecord(tc)) continue;
              const toolName = typeof tc.name === 'string' ? tc.name : undefined;
              const toolCallId = typeof tc.id === 'string' ? tc.id : undefined;
              if (!toolName || !toolCallId) continue;
              if (toolStatusSeen.has(toolCallId)) continue;
              toolStatusSeen.add(toolCallId);
              dataStream.writeData({
                type: 'tool_status',
                phase: 'start',
                toolName,
                toolCallId,
              } as unknown as JSONValue);
            }
            continue;
          }

          // Step 27.2:③ 源 tool_status:end — ToolNode 把工具 await 返回值包成 ToolMessage 发出
          // - 27.1 spike 实证 4/4 phase 全部从 ToolMessage.name 拿到具体工具名,带 tool_call_id 双重权威
          // - 进入本分支后必 continue,tools 节点 chunk 不会落到现役 filter(本就被 `if (node !== 'agent') continue` 丢)
          if (node === 'tools' && msg instanceof ToolMessage) {
            const toolName = typeof msg.name === 'string' ? msg.name : undefined;
            const toolCallId =
              typeof msg.tool_call_id === 'string' ? msg.tool_call_id : undefined;
            if (toolName && toolCallId) {
              dataStream.writeData({
                type: 'tool_status',
                phase: 'end',
                toolName,
                toolCallId,
              } as unknown as JSONValue);
            }
            continue;
          }

          if (node !== 'agent') continue;
          if (!(msg instanceof AIMessageChunk)) continue;
          const text = typeof msg.content === 'string' ? msg.content : '';
          if (!text) continue;
          fullText += text;
          // 23.3b 桥接关键一行(spike 验证 v4 协议 prefix 0: text)
          dataStream.write(formatDataStreamPart('text', text));
        }
      } catch (err: unknown) {
        // Step 25.1b 层 3:图级错误兜底——recursionLimit 超限 / abort 超时 / 其他
        // - 工具内异常已由层 1(tools.ts try/catch)+ 层 2(ToolNode handleToolErrors)
        //   接住,不会冒到这里;这里专接图级错误
        // - 降级文本经 dataStream.write 直推前端(不经 LLM 二次生成,避免二次失败)
        // - fullText 续接(决策①):已流 token + fallback,DB 与前端 UX 一致
        // - 三句 fallback 均不命中 REFUSAL_PATTERN_A/PATTERN_B 任一(决策③),不触发拒答清洗
        console.error('[chat] graph 异常:', err);
        const lcErrCode = (err as { lc_error_code?: string })?.lc_error_code;
        const errName = (err as { name?: string })?.name;

        let fallback: string;
        if (
          err instanceof GraphRecursionError ||
          lcErrCode === 'GRAPH_RECURSION_LIMIT'
        ) {
          fallback = '\n\n[系统] 工具调用次数过多,请简化您的问题或重新表达。';
        } else if (errName === 'AbortError') {
          fallback = '\n\n[系统] 对话超时,请简化您的问题或稍后再试。';
        } else {
          fallback = '\n\n[系统] 暂时无法生成回答,请稍后再试。';
        }
        dataStream.write(formatDataStreamPart('text', fallback));
        fullText += fallback;
      } finally {
        clearTimeout(timeoutId);
      }

      // Step 23.3c:聚合 collector → 去重 → 重编号 → Citation[]
      // 选项 A(已拍板):collector 用 chunkId 去重后按收集顺序统一编号 1..N。
      // 工具文本里的 [来源 N] 不参与编号(职责分离:工具主返回归 LLM,副产物归 collector)。
      // 已知接受瑕疵:多轮工具调用时 LLM 文本里 [来源 N] 可能与前端 chip 编号对不上,
      // 单轮 99% 完全对齐;不为多轮严格对齐引入 collector 全局递增编号那套复杂机制。
      const seen = new Set<string>();
      const uniqueChunks: CollectedChunk[] = [];
      for (const c of collector) {
        if (seen.has(c.chunkId)) continue;
        seen.add(c.chunkId);
        uniqueChunks.push(c);
      }
      const aggregatedCitations: Citation[] = uniqueChunks.map((c, i) => ({
        index: i + 1,
        chunkId: c.chunkId,
        documentId: c.documentId,
        documentTitle: c.documentTitle,
        content: c.content,
        similarity: c.similarity,
      }));

      // Step 23.3c 拒答清洗:双标记 AND 命中 → 置空
      // 覆盖"Agent 调了检索、collector 非空、但模型输出拒答"的 case(主题 7.2)
      let finalCitations: Citation[] = aggregatedCitations;
      if (isRefusalText(fullText)) {
        finalCitations = [];
      }

      // 流结束后写库(位置 A:graph stream 循环外)
      // assistant 行用 finalCitations(可能空可能全量),user 行 V1 约定固定 [](无引用)
      // 写库失败仅 console.error 不抛(主题 4.2),流响应已经发给用户
      try {
        await admin.from('chat_messages').insert([
          {
            session_id: finalSid,
            role: 'user',
            content: query,
            citations: [],
          },
          {
            session_id: finalSid,
            role: 'assistant',
            content: fullText,
            citations: finalCitations,
          },
        ]);
      } catch (e) {
        console.error('[chat] 写库失败(忽略,不影响响应):', e);
      }

      // 推流 citations:DB 与前端 data part 同源(同一个 finalCitations)
      // ChatWindow.tsx:282 latestCitations 从 data parts 抓 type='citations' 渲染 chip
      dataStream.writeData({
        type: 'citations',
        citations: finalCitations,
      } as unknown as JSONValue);
    },
    onError: (err) => {
      console.error('[chat] stream error:', err);
      return '对话流异常';
    },
  });
}
