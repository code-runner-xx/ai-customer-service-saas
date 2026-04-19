/**
 * Embedding 核心逻辑(无 server-only 约束版)
 *
 * 纯函数:apiKey / baseURL 作为参数传入,不读 process.env,
 * 因此可以被脚本、单元测试、Route Handler 共用。
 * 生产代码请通过薄包装 `./embed.ts` 调用。
 */
import OpenAI from 'openai';

export const EMBEDDING_MODEL = 'BAAI/bge-m3';
export const EMBEDDING_DIM = 1024;
const BATCH_SIZE = 100;
const MAX_RETRIES = 2;

export interface EmbedConfig {
  apiKey: string;
  baseURL: string;
}

async function embedBatch(
  client: OpenAI,
  batch: string[],
): Promise<number[][]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: batch,
      });
      return res.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding as number[]);
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw new Error(
    `调用 SiliconFlow embedding 失败(已重试 ${MAX_RETRIES} 次):${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

export async function embedTextsWithConfig(
  texts: string[],
  config: EmbedConfig,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!config.apiKey) throw new Error('embed-core: 缺少 apiKey');
  if (!config.baseURL) throw new Error('embed-core: 缺少 baseURL');

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const vectors = await embedBatch(client, batch);
    for (const v of vectors) {
      if (v.length !== EMBEDDING_DIM) {
        throw new Error(
          `embedding 维度异常:期望 ${EMBEDDING_DIM},实际 ${v.length}`,
        );
      }
    }
    out.push(...vectors);
  }
  return out;
}
