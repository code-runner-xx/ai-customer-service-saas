import 'server-only';
import { rerankDocuments, type RerankResult } from './rerank-core';

export const RERANK_MODEL = 'BAAI/bge-reranker-v2-m3';

export async function rerank(
  query: string,
  documents: string[],
  topN: number,
): Promise<RerankResult[]> {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  const baseURL = process.env.SILICONFLOW_BASE_URL;
  if (!apiKey) throw new Error('缺少环境变量 SILICONFLOW_API_KEY');
  if (!baseURL) throw new Error('缺少环境变量 SILICONFLOW_BASE_URL');
  return rerankDocuments({
    apiKey,
    baseURL,
    model: RERANK_MODEL,
    query,
    documents,
    topN,
  });
}

export type { RerankResult };
