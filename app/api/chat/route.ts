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

// ---------- 拒答检测(Step 23.3c 启用,Step 27.4 marker 加固)----------
// System prompt 仍指示 LLM 输出"抱歉,我在知识库中没有找到相关信息,建议您联系人工客服。"
// 保留 prompt 规范约束(LLM 越规范输出 marker 越易命中,正向引导)。
//
// 但 V2 Agent 化后 LLM 有自然化倾向会插字,如"没有找到【关于火星时间的】相关信息"(27.3 实测 9 字)
// → 旧 includes 找连续子串太脆,marker 1 漏判 → AND 整体 false → citations 未清(27.3 dev 手测⑤ 实证)。
//
// 27.4 改造:把单个长 marker 改成"语义核心片段组 + 允许中间插字"的正则,保持 AND 双条件(主题 7.2)
//   - PATTERN_A(语义"没查到内容"):(没有找到|未找到|查不到|找不到) 与 (相关信息|相关内容|相关资料)
//     之间允许插 0-30 字(实测插 9 字,30 字给冗余;{0,30} 上限挡远距误命中,31 字超界立即 false)
//   - PATTERN_B(语义"建议转人工"):(联系人工|人工客服|转人工) 任一
//   - 判定 = A.test && B.test(主题 7.2 AND 防误判初衷;主题 16.4 判文本不判 collector)
//
// 命中 → finalCitations 置空,DB 和前端 data part 同步不渲染引用 chip;
// 天然覆盖"Agent 调了检索、collector 非空、但模型输出拒答文本"的 case。
//
// 已知遗留(主题 18.2 不藏风险):双条件 AND 固有妥协 — 正常长回答里 A B 各自独立出现会被
// 误判 true(如"找不到该型号产品的相关信息,可以致电技术支持热线,也可以联系人工客服。"),
// 留给技术债 (o) 完整解(分数判/语义判),本 Step 不引入分数判 / collector 长度判 / LLM 自评。
const REFUSAL_PATTERN_A = /(没有找到|未找到|查不到|找不到)[\s\S]{0,30}(相关信息|相关内容|相关资料)/;
const REFUSAL_PATTERN_B = /(联系人工|人工客服|转人工)/;
function isRefusalText(text: string): boolean {
  return REFUSAL_PATTERN_A.test(text) && REFUSAL_PATTERN_B.test(text);
}

// ---------- V2 Agent system prompt ----------
// 拒答原句严格沿用 V1 措辞,同时命中 REFUSAL_PATTERN_A 与 PATTERN_B,
// 保证 Step 23.3c/27.4 接拒答清洗时 isRefusalText 双条件 AND 匹配能命中。
// Step 27.4 后 PATTERN_A 容忍中间插 0-30 字,即便 LLM 自然化输出"没有找到 XX 的相关信息"也能命中。
const SYSTEM_PROMPT = `你是企业专属客服助手。

可用工具:
- search_knowledge_base(query):检索知识库片段,用于回答"具体业务内容"问题(如使用方法、参数细节、故障处理、政策条款等)。
- list_documents():列出知识库现有文档的标题、状态、块数,用于回答"知识库元信息"问题(如"有哪些文档/你都知道什么内容/有什么资料/文档清单")。
- escalate_to_human(reason):用户明确要求转人工 / 投诉抱怨 / 多轮无法解决时调用,记录转人工请求并返回标准化文案。
- record_user_feedback(rating, comment?):用户主动对前一轮回答表达满意 / 不满意时调用,把评价写入数据库。rating 取值 'positive' 或 'negative',comment 可选,填用户原话要点。

工具选择规则:
- 元信息问题用 list_documents,具体内容问题用 search_knowledge_base。
- 不要为元问题去 search,也不要为内容问题去 list。
- 若两类信息都需要(如"先告诉我有什么文档,再讲第二份文档讲了什么"),可以先调 list_documents 再调 search_knowledge_base。
- 用户**明确**说"转人工 / 找真人客服 / 投诉 / 我要找你们经理"等 → 立即调 escalate_to_human。
- 同一问题连续 ≥2 轮 search 仍未解决、用户明显不满意或抱怨 → 调 escalate_to_human。
- ⚠️ 单次知识库找不到答案按工作方式第 4 条的话术回答,**不要**直接 escalate —— 知识库找不到 ≠ 转人工,只有"用户主动要转人工"或"多轮+不满"才 escalate。
- 用户**主动**说"有用 / 谢谢 / 解决了 / 太好了"等正面评价 → 调 record_user_feedback,rating='positive',comment 填用户原话要点。
- 用户**主动**说"没用 / 答错了 / 不对 / 答非所问"等负面评价 → 调 record_user_feedback,rating='negative',comment 填用户原话要点。
- ⚠️ 不要主动索要反馈、不要每轮都调 record_user_feedback;只在用户**自发**对前一轮 Agent 回答下评价时才调一次。

工作方式:
1. 判断问题类型后调用对应工具(规则见上);需要查知识库的问题禁止凭空回答。
2. 严格依据工具返回的内容作答,禁止编造工具结果以外的信息。
3. 仅当使用 search_knowledge_base 的检索片段作答时,回答末尾以 [来源 N] 标注引用编号(N 对应检索结果中的 [来源 N]);list_documents 返回的是元信息列表,无需 [来源 N]。
4. 如果 search_knowledge_base 检索结果与问题无关或为空,回答"抱歉,我在知识库中没有找到相关信息,建议您联系人工客服。"——禁止用其他措辞。
5. 调用 escalate_to_human 后,直接使用工具返回的文案回答用户,不要叠加 [来源 N]、不要改写措辞。
6. 调用 record_user_feedback 后,直接使用工具返回的文案回答用户,不要叠加 [来源 N]、不要改写措辞。
7. 用中文、简洁、分点作答。`;

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
