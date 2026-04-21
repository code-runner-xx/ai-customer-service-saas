import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * C 端匿名历史恢复 —— 方向 A(见 CLAUDE.md 第 13 节 Step 17)。
 *
 * 机制:
 *     按 `localStorage.aics_visitor_id` + `tenantId` 双条件精准匹配
 *     "该访客在该租户下最近一条 session",回填其 messages 到前端 useChat。
 *     GET /api/chat/history?tenantId=<uuid>&visitorId=<nanoid>
 *
 * 方向 A 的已知权衡(**不是 bug,是刻意设计**):
 *     1. 非真身份系统:没有登录 / 邮箱验证,只靠 visitorId 这个本机 token,
 *        任何人拿到同一 visitorId + tenantId 就能拉到对应历史。属"本机浏览器
 *        历史"级别保护,不是身份证。
 *     2. 换设备 / 清 localStorage → 换 visitorId → 变成新访客,历史不跟随。
 *     3. 多 session 不合并:只取 `created_at` 最大的一条 session,之前的
 *        session(如果有)不回填,避免多轮上下文混在一起。
 *     4. 跨设备同步需求对应方向 B(Magic Link / OTP 邮箱验证),目前明确搁置
 *        (会引入邮件服务和登录流,成本 / 复杂度远高于方向 A)。
 *
 * 多租户安全:
 *     admin client 绕过 RLS,SQL 必须显式 `WHERE user_id = tenantId AND
 *     visitor_id = visitorId`,两条件都是等值,任缺其一都是跨租户泄漏。
 *     chat_messages 表没有 user_id 列,只能靠 session_id 间接隔离 —— 因此
 *     session 查询必须严,才能保证 messages 查询不越界。
 *
 * 速率限制:
 *     和 /api/chat 共享 lib/rate-limit.ts 的内存 Map 键空间,避免在两端点间
 *     轮询绕过配额。Serverless 多实例下依然弱,见 rate-limit.ts 文件注释。
 */

const QuerySchema = z.object({
  tenantId: z.string().uuid('tenantId 必须是合法 UUID'),
  visitorId: z.string().min(1, 'visitorId 必填'),
});

export async function GET(request: Request) {
  // 1. 解析并校验 query params
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    tenantId: url.searchParams.get('tenantId'),
    visitorId: url.searchParams.get('visitorId'),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? '参数错误' },
      { status: 400 },
    );
  }
  const { tenantId, visitorId } = parsed.data;

  // 2. 速率限制(与 /api/chat 共享键空间)
  if (!checkRateLimit(visitorId)) {
    return NextResponse.json(
      { error: '请求过于频繁,请稍后再试' },
      { status: 429 },
    );
  }

  const admin = createAdminClient();

  // 3. 取该访客在该租户下最近一条 session(双条件等值过滤,防跨租户)
  const { data: sessions, error: sErr } = await admin
    .from('chat_sessions')
    .select('id')
    .eq('user_id', tenantId)
    .eq('visitor_id', visitorId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (sErr) {
    console.error('[chat/history] 查询 session 失败:', sErr);
    return NextResponse.json({ error: '查询会话失败' }, { status: 500 });
  }

  if (!sessions || sessions.length === 0) {
    // 无历史 → 返回空数组 + null sessionId
    return NextResponse.json({ messages: [], sessionId: null });
  }

  const sessionId = sessions[0].id as string;

  // 4. 查该 session 的 messages,按时间升序
  //    显式过滤 role:schema 允许 system,防御性地不把 system prompt 灌回前端
  const { data: rows, error: mErr } = await admin
    .from('chat_messages')
    .select('id, role, content, created_at')
    .eq('session_id', sessionId)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: true });

  if (mErr) {
    console.error('[chat/history] 查询 messages 失败:', mErr);
    return NextResponse.json({ error: '查询消息失败' }, { status: 500 });
  }

  // 5. 转成 useChat v4 initialMessages 格式
  //    citations 本轮不回填(方向 A 锦上添花项,见 CLAUDE.md Step 17 清单坑 4)
  const messages = (rows ?? []).map((r) => ({
    id: r.id as string,
    role: r.role as 'user' | 'assistant',
    content: r.content as string,
  }));

  return NextResponse.json({ messages, sessionId });
}
