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
import { createAdminClient } from '@/lib/supabase/admin';

interface RpcRow {
  id: string;
  document_id: string;
  content: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

// 行为对齐 lib/rag/retrieve.ts:同一 RPC、同一 embedding 模型、同一 topK
// 差异:显式传 min_similarity=0.3 锁住默认值(对齐 Step 22 + route.ts 显式声明习惯)
const TOP_K = 5;
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
      const vectors = await embedTexts([query]);
      const queryEmbedding = vectors[0];

      const admin = createAdminClient();
      const { data, error } = await admin.rpc('match_document_chunks', {
        query_embedding: queryEmbedding,
        tenant_id: tenantId,
        match_count: TOP_K,
        min_similarity: MIN_SIMILARITY,
      });

      if (error) {
        throw new Error(`向量检索失败:${error.message}`);
      }

      const rows = (data ?? []) as RpcRow[];
      if (rows.length === 0) {
        return '知识库中未找到与该问题相关的内容。';
      }

      // Step 23.3c:回填 documentTitle(RPC 不返,复刻 lib/rag/retrieve.ts 第二步)
      // ⚠️ 铁律 3 + EXPERIENCE 主题 6:admin client 显式 .eq('user_id', tenantId)
      //    不能漏,漏了即跨租户泄漏(C 端匿名调用同样走这条 admin 路径)
      const docIds = [...new Set(rows.map((r) => r.document_id))];
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
      for (const r of rows) {
        collector.push({
          chunkId: r.id,
          documentId: r.document_id,
          documentTitle: titleMap.get(r.document_id) ?? '未知文档',
          content: r.content,
          similarity: r.similarity,
        });
      }

      // 工具 return 与 23.2 完全一致(LLM 看到的契约字节级不变)
      return rows.map((r, i) => `[来源 ${i + 1}] ${r.content}`).join('\n\n');
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
    },
    {
      name: 'list_documents',
      description:
        '列出当前租户知识库内所有文档的标题、处理状态与块数。当用户询问"知识库有哪些文档/你都知道什么内容/有什么资料/文档清单"等元信息时调用;不要用于回答具体业务问题。',
      schema: z.object({}),
    },
  );
}
