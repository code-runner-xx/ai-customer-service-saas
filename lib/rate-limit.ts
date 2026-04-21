/**
 * C 端端点速率限制 —— 基于进程内存 Map,按 visitorId 维度计数。
 *
 * ⚠️ Serverless 多实例限制(对齐 CLAUDE.md 0.11 Step 16 待办 d):
 *     Vercel Serverless 下每个 Function 实例持有独立 Map 副本,同一 visitorId
 *     的请求若被路由到不同实例,各实例分别计数,全局窗口上限实际被放大 N 倍,
 *     极端下接近裸奔。当前实现挡得住偶发刷屏和常规枚举,不足以挡有针对性的爆破,
 *     属 MVP 已接受风险。生产级修复:换 Upstash Redis(Vercel Marketplace
 *     一键集成,免费额度对 MVP 够用)。
 *
 * 共享键空间设计:
 *     Chat (POST /api/chat) 与 History (GET /api/chat/history) 两个端点
 *     import 同一个 `rateLimitMap` 实例(ESM 模块缓存保证同进程只有一份),
 *     避免攻击者通过在两端点之间轮询绕过单端点配额。
 */

const rateLimitMap = new Map<string, number[]>();

export const RATE_LIMIT_WINDOW_MS = 60_000; // 60 秒
export const RATE_LIMIT_MAX = 20;           // 每窗口最多 20 次请求
// 懒清理阈值:Map 过大时才扫描删除过期键,避免每次请求都遍历全表
const LAZY_CLEANUP_THRESHOLD = 1000;

/**
 * 检查并记录一次请求。
 * @returns true = 允许;false = 超限
 */
export function checkRateLimit(visitorId: string): boolean {
  const now = Date.now();
  const timestamps = (rateLimitMap.get(visitorId) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS,
  );

  if (timestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }

  timestamps.push(now);
  rateLimitMap.set(visitorId, timestamps);

  if (rateLimitMap.size > LAZY_CLEANUP_THRESHOLD) {
    for (const [key, ts] of rateLimitMap) {
      if (ts.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) {
        rateLimitMap.delete(key);
      }
    }
  }

  return true;
}
