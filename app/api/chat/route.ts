import { createDataStreamResponse, streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import type { CoreMessage, JSONValue } from 'ai';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { retrieveContext } from '@/lib/rag/retrieve';
import { checkRateLimit } from '@/lib/rate-limit';

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

  // 3. 取最后一条 user 消息作为检索 query
  const rawMessages = messages as Array<{ role: string; content: unknown }>;
  const lastUserMsg = [...rawMessages]
    .reverse()
    .find((m) => m.role === 'user');

  if (!lastUserMsg || typeof lastUserMsg.content !== 'string' || !lastUserMsg.content.trim()) {
    return new Response('消息列表中没有有效的用户消息', { status: 400 });
  }
  const query = lastUserMsg.content.trim();

  // 4. 向量检索
  const { chunks, contextText } = await retrieveContext(query, tenantId, 5);

  // 5. 构造 citations
  const citations: Citation[] = chunks.map((c, i) => ({
    index: i + 1,
    chunkId: c.chunkId,
    documentId: c.documentId,
    documentTitle: c.documentTitle,
    content: c.content,
    similarity: c.similarity,
  }));

  // 6. System prompt
  const systemPrompt = `你是企业专属客服助手。严格依据下方【知识上下文】回答用户问题。
规则:
1. 若上下文中没有相关信息,回答"抱歉,我在知识库中没有找到相关信息,建议您联系人工客服。",禁止编造。
2. 回答末尾以 [来源 N] 标注引用编号。
3. 用中文、简洁、分点作答。

【知识上下文】
${contextText}`;

  // 7. SiliconFlow DeepSeek-V3 模型
  const siliconflow = createOpenAI({
    apiKey: process.env.SILICONFLOW_API_KEY!,
    baseURL: process.env.SILICONFLOW_BASE_URL!,
  });
  const model = siliconflow('deepseek-ai/DeepSeek-V3');

  // 8. 建 session(若无)
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

  // finalSid 供 onFinish 闭包使用(TypeScript 确认非 undefined)
  const finalSid = sid;

  // 9. 流式响应
  return createDataStreamResponse({
    execute: async (dataStream) => {
      // 先把 sessionId 推给前端
      dataStream.writeData({ type: 'session', sessionId: finalSid } as unknown as JSONValue);

      const result = streamText({
        model,
        system: systemPrompt,
        messages: messages as unknown as CoreMessage[],
        onFinish: async ({ text }) => {
          // 写库失败不影响已流给用户的响应
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
                content: text,
                citations: citations,
              },
            ]);
          } catch (e) {
            console.error('[chat] onFinish 写库失败(忽略,不影响响应):', e);
          }
        },
      });

      // 把 LLM 流合并进 dataStream
      result.mergeIntoDataStream(dataStream);

      // 等 LLM 全部生成完毕,再把 citations 推给前端
      await result.text;
      dataStream.writeData({ type: 'citations', citations } as unknown as JSONValue);
    },
    onError: (err) => {
      console.error('[chat] stream error:', err);
      return '对话流异常';
    },
  });
}
