import 'server-only';
import {
  embedTextsWithConfig,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
} from './embed-core';

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  const baseURL = process.env.SILICONFLOW_BASE_URL;
  if (!apiKey) throw new Error('缺少环境变量 SILICONFLOW_API_KEY');
  if (!baseURL) throw new Error('缺少环境变量 SILICONFLOW_BASE_URL');
  return embedTextsWithConfig(texts, { apiKey, baseURL });
}

export { EMBEDDING_DIM, EMBEDDING_MODEL };
