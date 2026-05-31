import { createDataStreamResponse, formatDataStreamPart } from 'ai';
import { z } from 'zod';
import type { JSONValue } from 'ai';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit } from '@/lib/rate-limit';
import { makeAgentGraph } from '@/lib/agent/graph';
import type { CollectedChunk } from '@/lib/agent/tools';

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

// ---------- 拒答检测(Step 23.3c 启用)----------
// System prompt 原话:"抱歉,我在知识库中没有找到相关信息,建议您联系人工客服。"
// 取两串高辨识度片段做 AND 匹配:容忍 LLM 微改标点/缺字,也避免真实答案里偶尔出现单串被误伤。
// 命中 → finalCitations 置空,DB 和前端 data part 同步不渲染引用 chip;
// 天然覆盖"Agent 调了检索、collector 非空、但模型输出拒答文本"的 case。
const REFUSAL_MARKERS = ['没有找到相关信息', '联系人工客服'];
function isRefusalText(text: string): boolean {
  return REFUSAL_MARKERS.every((m) => text.includes(m));
}

// ---------- V2 Agent system prompt ----------
// 拒答原句严格沿用 V1 措辞,含 REFUSAL_MARKERS 两词,保证 Step 23.3c 接拒答清洗时
// isRefusalText 双标记 AND 匹配能命中。
const SYSTEM_PROMPT = `你是企业专属客服助手。

可用工具:
- search_knowledge_base(query):检索知识库片段,用于回答"具体业务内容"问题(如使用方法、参数细节、故障处理、政策条款等)。
- list_documents():列出知识库现有文档的标题、状态、块数,用于回答"知识库元信息"问题(如"有哪些文档/你都知道什么内容/有什么资料/文档清单")。

工具选择规则:
- 元信息问题用 list_documents,具体内容问题用 search_knowledge_base。
- 不要为元问题去 search,也不要为内容问题去 list。
- 若两类信息都需要(如"先告诉我有什么文档,再讲第二份文档讲了什么"),可以先调 list_documents 再调 search_knowledge_base。

工作方式:
1. 判断问题类型后调用对应工具(规则见上);需要查知识库的问题禁止凭空回答。
2. 严格依据工具返回的内容作答,禁止编造工具结果以外的信息。
3. 仅当使用 search_knowledge_base 的检索片段作答时,回答末尾以 [来源 N] 标注引用编号(N 对应检索结果中的 [来源 N]);list_documents 返回的是元信息列表,无需 [来源 N]。
4. 如果 search_knowledge_base 检索结果与问题无关或为空,回答"抱歉,我在知识库中没有找到相关信息,建议您联系人工客服。"——禁止用其他措辞。
5. 用中文、简洁、分点作答。`;

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

  // 5. 构造 V2 Agent graph(tenantId 闭包注入工具,LLM 不可见)
  //    Step 23.3c 路径 β:graph 内部 new collector,工具闭包 push,
  //    route.ts 流跑完读 collector 做"去重 + 重编号 + 拒答清洗"
  const { graph, collector } = makeAgentGraph(tenantId);

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

      let fullText = '';
      for await (const chunk of await graph.stream(
        { messages: langchainMessages },
        { streamMode: 'messages' },
      )) {
        if (!Array.isArray(chunk) || chunk.length < 2) continue;
        const [msg, metadata] = chunk;
        // spike 坑 3 心法:agent 节点 + content 非空 = 最终回答 token
        // 自动排除:tools 节点输出、step=1 的 tool_call 增量流(content 全空)
        const node = isRecord(metadata) ? metadata.langgraph_node : undefined;
        if (node !== 'agent') continue;
        if (!(msg instanceof AIMessageChunk)) continue;
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (!text) continue;
        fullText += text;
        // 23.3b 桥接关键一行(spike 验证 v4 协议 prefix 0: text)
        dataStream.write(formatDataStreamPart('text', text));
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
