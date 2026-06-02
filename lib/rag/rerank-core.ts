/**
 * Rerank 核心逻辑(无 server-only 约束版)
 *
 * 纯函数:apiKey / baseURL / model 作为参数传入,不读 process.env,
 * 因此可以被脚本、单元测试、Route Handler 共用。
 * 生产代码请通过薄包装 `./rerank.ts` 调用。
 *
 * 注1:documents 数组无 32 条上限(Step 26.1 spike 实测至少 200 条 OK)。
 *      主题 7.1 的 32 条硬上限是 /embeddings 的 input 字段,与这里 /rerank 的
 *      documents 是两回事,勿混。
 * 注2:错误处理顺序 status → text() → JSON.parse 不可调换。
 *      主题 7.1 教训:空 body 的 413 类响应,顺序反了会吞根因。
 */

export interface RerankResult {
  index: number;
  relevanceScore: number;
}

export interface RerankParams {
  apiKey: string;
  baseURL: string;
  model: string;
  query: string;
  documents: string[];
  topN: number;
}

interface RerankResultRaw {
  index: number;
  relevance_score: number;
}

function isRerankResultRaw(v: unknown): v is RerankResultRaw {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.index === 'number' && typeof obj.relevance_score === 'number';
}

function extractResults(parsed: unknown): RerankResultRaw[] {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('rerank 返回不是对象');
  }
  const obj = parsed as Record<string, unknown>;
  const results = obj.results;
  if (!Array.isArray(results)) {
    throw new Error('rerank 返回缺少 results 数组');
  }
  for (const item of results) {
    if (!isRerankResultRaw(item)) {
      throw new Error(
        `rerank results 项字段不符:期望 { index:number, relevance_score:number },实际 ${JSON.stringify(item).slice(0, 200)}`,
      );
    }
  }
  return results;
}

export async function rerankDocuments(params: RerankParams): Promise<RerankResult[]> {
  const { apiKey, baseURL, model, query, documents, topN } = params;

  if (documents.length === 0) return [];

  if (!apiKey) throw new Error('rerank-core: 缺少 apiKey');
  if (!baseURL) throw new Error('rerank-core: 缺少 baseURL');
  if (!model) throw new Error('rerank-core: 缺少 model');

  const url = `${baseURL.replace(/\/+$/, '')}/rerank`;
  const body = {
    model,
    query,
    documents,
    top_n: topN,
    return_documents: false,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // 严格顺序:status → text() → JSON.parse(主题 7.1,顺序不可调换)
  const status = resp.status;
  const rawText = await resp.text();

  if (!resp.ok) {
    throw new Error(
      `SiliconFlow rerank HTTP ${status}:${rawText.slice(0, 500) || '(空 body)'}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `SiliconFlow rerank JSON.parse 失败:${(err as Error).message} | raw 前 500 字:${rawText.slice(0, 500)}`,
    );
  }

  const rawResults = extractResults(parsed);
  // API 已按 relevance_score 降序(26.1 spike 实证),core 不再重排
  return rawResults.map((r) => ({
    index: r.index,
    relevanceScore: r.relevance_score,
  }));
}
