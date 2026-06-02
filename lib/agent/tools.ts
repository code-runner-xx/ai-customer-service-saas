// V2 Step 23.2 — LangGraph Agent 工具集
// V2 Step 23.3c — 加 collector 副产物 + 回填 documentTitle
//
// 本文件被生产 route.ts(Step 23.3 接入)import,运行在 Next.js 服务端,
// 通过 lib/rag/embed + lib/supabase/admin 间接走 server-only 链路。
// 本文件自身不显式声明 server-only,对齐 lib/rag/retrieve.ts 的范式
// —— 靠依赖链单向传染保护,任何 client 误 import 会在 embed.ts/admin.ts 处抛错。
//
// 关键设计(铁律 3 + EXPERIENCE 主题 6:多租户隔离靠代码强制,不靠 LLM 自觉):
// - tenantId 通过工厂函数闭包捕获,不进入工具 schema
// - LLM 看到的工具签名只有 { query },看不到也改不了 tenantId
//
// Step 23.3c 新增:
// - collector 参数同样闭包捕获,工具内部检索后把结构化 chunks 作为副产物 push 进去
// - 工具 return 值与 23.2 完全一致(Promise<string> 的 contextText),LLM 输入不变
// - documentTitle 复刻 lib/rag/retrieve.ts 第二步:去重 document_id → 批量查
//   documents 表 .select('id,title').in('id',docIds).eq('user_id', tenantId)
//   ⚠️ .eq('user_id', tenantId) 不能漏(铁律 3),admin client 漏了即跨租户泄漏

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { embedTexts } from '@/lib/rag/embed';
import { rerank } from '@/lib/rag/rerank';
import { createAdminClient } from '@/lib/supabase/admin';

interface RpcRow {
  id: string;
  document_id: string;
  content: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

// 行为对齐 lib/rag/retrieve.ts:同一 RPC、同一 embedding 模型
// 差异:显式传 min_similarity=0.3 锁住默认值(对齐 Step 22 + route.ts 显式声明习惯)
//
// Step 26.3:召回 RECALL_K 条 → rerank 精排到 FINAL_K 条
// - RECALL_K=20:rerank 候选池大小(26.1 实测 20 条 ~500-800ms,远低于 50s wall-clock)
// - FINAL_K=5:进入后续 contextText / collector / 编号的最终条数(与 V2 原 TOP_K 一致,保后半段不变)
// - RERANK_TIMEOUT_MS=3000:rerank 独立超时,失败/超时静默回退召回 pgvector top-5
const RECALL_K = 20;
const FINAL_K = 5;
const RERANK_TIMEOUT_MS = 3000;
const MIN_SIMILARITY = 0.3;

/**
 * Step 23.3c collector 元素类型
 *
 * 字段对齐 V1 Citation,但不含 index —— index 在 route.ts 聚合时统一重编 1..N,
 * 多轮工具调用产生重复 chunkId 时也在 route 端按 chunkId 去重。
 */
export interface CollectedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  similarity: number;
}

/**
 * 创建 search_knowledge_base 工具(LangGraph Agent 用)
 *
 * @param tenantId  租户 ID,闭包捕获,绝不暴露给 LLM
 * @param collector Step 23.3c:闭包捕获的数组,每次工具调用都把结构化 chunks
 *                  作为副产物 push 进去;工具 return 的 contextText 字符串不变
 */
export function makeSearchKnowledgeBaseTool(
  tenantId: string,
  collector: CollectedChunk[],
) {
  return tool(
    async ({ query }: { query: string }): Promise<string> => {
      // Step 25.1b 层 1:工具体外层 try/catch 控降级文案质量
      // - 不是为了防 500(ToolNode handleToolErrors:true 已防,25.1a-spike T3 实证)
      // - 而是避免 LLM 看到英文 Error 提示后生成不可控话术 / 浪费 recursionLimit 重试
      // - 内部 embed/RPC/documents 查询/collector push 实现一字不动,只加容错壳
      // - 降级串不含 REFUSAL_MARKERS 任一标记(没有找到相关信息 / 联系人工客服),
      //   避免被 isRefusalText 双标记 AND 匹配误清洗(主题 7.2)
      try {
        const vectors = await embedTexts([query]);
        const queryEmbedding = vectors[0];

        const admin = createAdminClient();
        const { data, error } = await admin.rpc('match_document_chunks', {
          query_embedding: queryEmbedding,
          tenant_id: tenantId,
          match_count: RECALL_K,
          min_similarity: MIN_SIMILARITY,
        });

        if (error) {
          throw new Error(`向量检索失败:${error.message}`);
        }

        const rows = (data ?? []) as RpcRow[];
        if (rows.length === 0) {
          return '知识库中未找到与该问题相关的内容。';
        }

        // Step 26.3:召回 RECALL_K → rerank 精排 FINAL_K
        // rerank 降级 = 精排失败,静默回退召回 pgvector top-5(检索成功,仅精排失败)
        // 区别于 Step 25.1 工具级降级串 = 整个检索失败返中文文案(主题 17.4 层1)。两者不同层,勿混。
        // - 独立 try/catch,与外层 Step 25.1 层 1 不复用
        // - AbortController + RERANK_TIMEOUT_MS 透传 signal(主题 17.2,fetch 原生认 signal)
        // - 失败/超时:console.warn 留痕 + finalRows = rows.slice(0, FINAL_K)(pgvector top-5)
        // - 不返中文降级文案、不往 collector 推降级标记 —— 前端对 rerank 降级完全无感
        let finalRows: RpcRow[];
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);
          try {
            const reranked = await rerank(
              query,
              rows.map((r) => r.content),
              FINAL_K,
              controller.signal,
            );
            finalRows = reranked.map((rr) => rows[rr.index]);
          } finally {
            clearTimeout(timer);
          }
        } catch (err: unknown) {
          console.warn('[tool/search] rerank 降级 → 回退召回 pgvector top-5', {
            tenantId,
            query,
            err:
              err instanceof Error
                ? { name: err.name, message: err.message }
                : err,
          });
          finalRows = rows.slice(0, FINAL_K);
        }

        // Step 23.3c:回填 documentTitle(RPC 不返,复刻 lib/rag/retrieve.ts 第二步)
        // ⚠️ 铁律 3 + EXPERIENCE 主题 6:admin client 显式 .eq('user_id', tenantId)
        //    不能漏,漏了即跨租户泄漏(C 端匿名调用同样走这条 admin 路径)
        const docIds = [...new Set(finalRows.map((r) => r.document_id))];
        const { data: docs, error: docErr } = await admin
          .from('documents')
          .select('id, title')
          .in('id', docIds)
          .eq('user_id', tenantId);

        if (docErr) {
          throw new Error(`查询文档标题失败:${docErr.message}`);
        }

        const titleMap = new Map(
          (docs ?? []).map((d: { id: string; title: string }) => [
            d.id,
            d.title,
          ]),
        );

        // Step 23.3c 副产物:结构化字段 push 进 collector(LLM 不可见)
        // 多轮工具调用时同一 chunkId 可能被多次 push,去重责任在 route.ts 聚合时统一做
        for (const r of finalRows) {
          collector.push({
            chunkId: r.id,
            documentId: r.document_id,
            documentTitle: titleMap.get(r.document_id) ?? '未知文档',
            content: r.content,
            similarity: r.similarity,
          });
        }

        // 工具 return 与 23.2 完全一致(LLM 看到的契约字节级不变)
        return finalRows.map((r, i) => `[来源 ${i + 1}] ${r.content}`).join('\n\n');
      } catch (err: unknown) {
        console.error('[tool/search] 失败(降级):', { tenantId, query, err });
        return '当前知识库检索暂时不可用,请稍后再试或换个表达方式。';
      }
    },
    {
      name: 'search_knowledge_base',
      description:
        '检索企业知识库,返回最相关的文档片段。当用户问题需要查阅知识库内容时调用。',
      schema: z.object({
        query: z.string().describe('要检索的问题或关键词'),
      }),
    },
  );
}

// ---------- Step 24.1 list_documents 工具 ----------
// 与 makeSearchKnowledgeBaseTool 同构:tenantId 闭包注入、schema 不暴露 tenantId(LLM 不可见)。
// 纯读、无副产物,不接 collector(不污染 citations 通道,citations 仅来源于 search_knowledge_base)。
// 用途:Agent 回答"知识库有哪些文档"这类元问题。

interface DocumentRow {
  id: string;
  title: string;
  status: string;
  chunk_count: number | null;
}

function statusToChinese(status: string): string {
  if (status === 'processing') return '处理中';
  if (status === 'ready') return '就绪';
  if (status === 'failed') return '失败';
  return status;
}

export function makeListDocumentsTool(tenantId: string) {
  return tool(
    async (): Promise<string> => {
      // Step 25.1b 层 1:工具体外层 try/catch 控降级文案质量(同 search 注释)
      // 降级串不含 REFUSAL_MARKERS 任一标记,避免拒答清洗误触
      try {
        const admin = createAdminClient();
        // ⚠️ 铁律 3 + EXPERIENCE 主题 6/16.2:admin client 必须显式 .eq('user_id', tenantId)
        //    漏了即跨租户泄漏(C 端匿名同样走这条 admin 路径)
        const { data, error } = await admin
          .from('documents')
          .select('id, title, status, chunk_count')
          .eq('user_id', tenantId)
          .order('created_at', { ascending: false });

        if (error) {
          throw new Error(`查询文档列表失败:${error.message}`);
        }

        const rows = (data ?? []) as DocumentRow[];
        if (rows.length === 0) {
          return '当前知识库暂无文档。';
        }

        // 主返回字符串(主题 16.1:工具主返回服务 LLM,不用结构化 JSON)
        return rows
          .map(
            (r) =>
              `「${r.title}」— ${statusToChinese(r.status)} — ${r.chunk_count ?? 0} 块`,
          )
          .join('\n');
      } catch (err: unknown) {
        console.error('[tool/list] 失败(降级):', { tenantId, err });
        return '当前无法获取知识库文档列表,请稍后再试。';
      }
    },
    {
      name: 'list_documents',
      description:
        '列出当前租户知识库内所有文档的标题、处理状态与块数。当用户询问"知识库有哪些文档/你都知道什么内容/有什么资料/文档清单"等元信息时调用;不要用于回答具体业务问题。',
      schema: z.object({}),
    },
  );
}

// ---------- Step 24.2 escalate_to_human 工具 ----------
// 与 search/list 同构:tenantId/sessionId 闭包注入,schema 只暴露 { reason }(LLM 不可见 ids)。
// 用途:用户明确要求转人工 / 投诉抱怨 / 多轮答不好时记录转人工意图。
//
// 隔离设计(铁律 3 + EXPERIENCE 主题 6.2):
// - chat_messages 没有 user_id 列,隔离 100% 靠 sessionId 间接做。
// - sessionId 必须是 route.ts 已建立/已校验的 finalSid(在 chat_sessions 层与 tenantId 强绑)。
// - 绝不能让 LLM 通过参数传 sessionId —— 它幻觉一个 session_id 即跨租户写。
// - tenantId 当前不参与 SQL 过滤,仅用于失败日志携带租户上下文 / 未来扩展(若后续 escalate
//   需要写带 user_id 的新表则备好);保留它对齐主题 16.1 工厂闭包范式。
//
// 与 23.3c citations 通道的关系(动手约束 B):
// - escalate 的这条 admin insert 是独立的 role='system' chat_messages 记录,
//   与 route.ts onFinish 写 assistant 消息的那条是两条不同 insert。
// - 完全不读 / 不写 / 不触碰 collector、不影响 finalCitations 聚合。
// - 23.3c 红线(collector 通道 + 拒答清洗)与本工具零交集。
//
// 容错策略(主题 4.2):
// - 写库失败仅 console.error 不抛 —— 转人工是用户感知操作,运营侧丢一条记录可接受,
//   用户不能看到"转人工失败"会更焦虑。无论写库成败都返回同一句成功文案给 LLM。
//
// content 列规范(动手约束 A):
// - 纯 `ESCALATION: ${reason}`,不拼 visitor_id / timestamp / 其他上下文。
// - 可追溯信息靠 created_at + join chat_sessions 拿,不冗余进 text 列。

export function makeEscalateToHumanTool(
  tenantId: string,
  sessionId: string,
) {
  return tool(
    async ({ reason }: { reason: string }): Promise<string> => {
      const admin = createAdminClient();
      try {
        // 独立 insert:与 route.ts onFinish 写 assistant 消息那条完全独立,
        // 不读不写 collector / finalCitations(动手约束 B)
        await admin.from('chat_messages').insert({
          session_id: sessionId,
          role: 'system',
          content: `ESCALATION: ${reason.trim().slice(0, 500)}`,
          citations: [],
        });
      } catch (err) {
        // 主题 4.2:副作用失败不阻断、不抛、不让用户看到运营侧失败
        // tenantId 仅用于失败日志携带租户上下文(SQL 过滤靠 sessionId)
        console.error('[tool/escalate] 写库失败(忽略):', {
          tenantId,
          sessionId,
          err,
        });
      }
      // 不论写库成败,LLM 都拿到同一句成功文案
      return '已为您记录转人工请求,工作人员会尽快与您联系。';
    },
    {
      name: 'escalate_to_human',
      description:
        '当用户明确要求转人工 / 投诉抱怨 / 多轮无法解决问题时调用,记录转人工请求并返回标准化文案。',
      schema: z.object({
        reason: z
          .string()
          .min(1, 'reason 不能为空')
          .max(500)
          .describe(
            '用中文简明描述触发转人工的原因(如「用户多次询问退款问题未得解决」)',
          ),
      }),
    },
  );
}

// ---------- Step 24.3 record_user_feedback 工具 ----------
// 与 escalate 同构:tenantId/sessionId 闭包注入,schema 只暴露 { rating, comment? }(LLM 不可见 ids)。
// 用途:用户**主动**对前一轮 Agent 回答表达满意/不满时,把评价写入 user_feedback 表。
//
// 隔离设计(铁律 3 + EXPERIENCE 主题 6/16.1):
// - user_feedback 没有 user_id 列,隔离 100% 靠 sessionId 间接做(经 chat_sessions 与 tenantId 强绑)。
// - sessionId 必须是 route.ts 已建立/已校验的 finalSid,绝不能让 LLM 通过参数传。
// - tenantId 当前不参与 SQL 过滤,仅用于失败日志携带租户上下文 / 未来扩展;保留它对齐主题 16.1 闭包范式。
//
// message_id 取舍(方案 A):
// - 当前轮 assistant 消息的 DB id 在 route.ts onFinish 流结束后才 insert 生成,
//   工具调用发生在流进行中,时序上拿不到。强行传会语义错位。
// - user_feedback.message_id 已设计为可空,insert 时不带该字段、DB 落 NULL,避免错链。
// - 后续若需精确钉到某条 assistant 行,通过 created_at 时间窗 join chat_sessions/chat_messages 反查即可。
//
// 与 23.3c citations 通道的关系:
// - 这条 admin insert 写的是 user_feedback 表,与 collector / finalCitations / chat_messages 三条道完全独立。
// - 拒答清洗 / 三连坑修法 / collector 通道 0 触碰。
//
// 容错策略(主题 4.2):
// - 写库失败仅 console.error 不抛 —— 评价是运营信号,丢一条比让用户看到"反馈失败"更好。
// - 无论写库成败都返同一句成功文案给 LLM。
//
// comment 防御:
// - 运行时统一 `comment?.trim().slice(0, 1000) || null`:undefined / 空串 / 全空白 → null,
//   与 user_feedback.comment 可空一致(DB 落 SQL NULL),避免存"空白条"。

export function makeRecordUserFeedbackTool(
  tenantId: string,
  sessionId: string,
) {
  return tool(
    async ({
      rating,
      comment,
    }: {
      rating: 'positive' | 'negative';
      comment?: string;
    }): Promise<string> => {
      const admin = createAdminClient();
      // undefined / 空串 / 全空白 统一归 null,落库为 SQL NULL(动手注意)
      const normalizedComment: string | null =
        comment?.trim().slice(0, 1000) || null;
      try {
        // 独立 insert:与 route.ts onFinish 写 assistant、与 escalate 写 chat_messages 三条均独立,
        // 不读不写 collector / finalCitations(23.3c 红线零交集)。
        // message_id 不写(方案 A,留 NULL):流中无法拿到本轮 assistant 行的 DB id。
        await admin.from('user_feedback').insert({
          session_id: sessionId,
          rating,
          comment: normalizedComment,
        });
      } catch (err) {
        // 主题 4.2:副作用失败不阻断、不抛、不让用户看到运营侧失败
        // tenantId 仅用于失败日志携带租户上下文(SQL 过滤靠 sessionId)
        console.error('[tool/feedback] 写库失败(忽略):', {
          tenantId,
          sessionId,
          rating,
          err,
        });
      }
      // 不论写库成败,LLM 都拿到同一句成功文案
      return '感谢您的反馈,我们会持续改进。';
    },
    {
      name: 'record_user_feedback',
      description:
        '当用户主动对前一轮回答表达满意(如「有用」「谢谢」「解决了」)或不满(如「没用」「答错了」「不对」)时调用,记录其评价。不要主动索取反馈、不要每轮都调。',
      schema: z.object({
        rating: z
          .enum(['positive', 'negative'])
          .describe(
            '用户对前一轮回答的评价:positive=满意,negative=不满',
          ),
        comment: z
          .string()
          .max(1000)
          .optional()
          .describe(
            '可选,用中文简明记录用户原话要点(如「答案准确解决了我的问题」)',
          ),
      }),
    },
  );
}
