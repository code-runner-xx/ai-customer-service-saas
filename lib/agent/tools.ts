// V2 Step 23.2 — LangGraph Agent 工具集
//
// 本文件被生产 route.ts(Step 23.3 接入)import,运行在 Next.js 服务端,
// 通过 lib/rag/embed + lib/supabase/admin 间接走 server-only 链路。
// 本文件自身不显式声明 server-only,对齐 lib/rag/retrieve.ts 的范式
// —— 靠依赖链单向传染保护,任何 client 误 import 会在 embed.ts/admin.ts 处抛错。
//
// 关键设计(铁律 3 + EXPERIENCE 主题 6:多租户隔离靠代码强制,不靠 LLM 自觉):
// - tenantId 通过工厂函数闭包捕获,不进入工具 schema
// - LLM 看到的工具签名只有 { query },看不到也改不了 tenantId

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
 * 创建 search_knowledge_base 工具(LangGraph Agent 用)
 *
 * @param tenantId  租户 ID,闭包捕获,绝不暴露给 LLM
 */
export function makeSearchKnowledgeBaseTool(tenantId: string) {
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
