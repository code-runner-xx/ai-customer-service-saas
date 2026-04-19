import { embedTexts } from './embed';
import { createAdminClient } from '@/lib/supabase/admin';

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  similarity: number;
}

export interface RetrieveResult {
  chunks: RetrievedChunk[];
  /** "[来源 1] …\n\n[来源 2] …" 形式,直接插入 system prompt */
  contextText: string;
}

interface RpcRow {
  id: string;
  document_id: string;
  content: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

/**
 * 检索与 query 最相关的 topK 个 chunk。
 * 使用 admin client:C 端匿名场景也能调;函数内已按 tenant_id 参数过滤,
 * 额外查 documents 时也显式带 user_id = tenantId(铁律 3)。
 */
export async function retrieveContext(
  query: string,
  tenantId: string,
  topK = 5,
): Promise<RetrieveResult> {
  // 1. 将 query 向量化
  const vectors = await embedTexts([query]);
  const queryEmbedding = vectors[0];

  const admin = createAdminClient();

  // 2. 向量相似度搜索
  const { data: rows, error: rpcErr } = await admin.rpc(
    'match_document_chunks',
    {
      query_embedding: queryEmbedding,
      tenant_id: tenantId,
      match_count: topK,
    },
  );

  if (rpcErr) {
    throw new Error(`向量检索失败:${rpcErr.message}`);
  }

  const rpcRows = (rows ?? []) as RpcRow[];
  if (rpcRows.length === 0) {
    return { chunks: [], contextText: '' };
  }

  // 3. 去重 document_id,批量回填 title
  const docIds = [...new Set(rpcRows.map((r) => r.document_id))];
  const { data: docs, error: docErr } = await admin
    .from('documents')
    .select('id, title')
    .in('id', docIds)
    .eq('user_id', tenantId); // 显式 user_id 兜底,铁律 3

  if (docErr) {
    throw new Error(`查询文档标题失败:${docErr.message}`);
  }

  const titleMap = new Map(
    (docs ?? []).map((d: { id: string; title: string }) => [d.id, d.title]),
  );

  // 4. 组装 RetrievedChunk[]
  const chunks: RetrievedChunk[] = rpcRows.map((r) => ({
    chunkId: r.id,
    documentId: r.document_id,
    documentTitle: titleMap.get(r.document_id) ?? '未知文档',
    content: r.content,
    similarity: r.similarity,
  }));

  // 5. 拼接 contextText
  const contextText = chunks
    .map((c, i) => `[来源 ${i + 1}] ${c.content}`)
    .join('\n\n');

  return { chunks, contextText };
}
