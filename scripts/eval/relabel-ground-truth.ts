// V2 Step 22 阶段 2b — 重新定位评估测试集的 ground truth
//
// ⚠️ 严禁写数据库:本文件不出现 .insert / .update / .delete / .upsert / .rpc
//    只读 document_chunks + eval/testset.jsonl,只写本地 eval/testset-relabeled.jsonl
//    原 eval/testset.jsonl 保留不动,用于对照
//
// 注意:tsx 脚本环境,不能加 'server-only'(EXPERIENCE 主题 1.2)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';

// 测试账号 A(见 HANDOFF 第四节)
const TENANT_ID = 'afcd94f9-8a2f-4d5e-b4f3-36dee5e8320e';
const INPUT_PATH = 'eval/testset.jsonl';
const OUTPUT_PATH = 'eval/testset-relabeled.jsonl';
const MODEL = 'deepseek-ai/DeepSeek-V3';
const TEMPERATURE = 0.3;
const PREVIEW_CHARS = 60;
const NONE_PREVIEW = '(none — 无 chunk 可定位答案)';

interface ChunkRow {
  id: string;
  content: string;
}

interface OriginalEntry {
  id: string;
  question: string;
  question_type: 'fact' | 'colloquial';
  ground_truth_chunk_id: string;
}

type LabelConfidence = 'single' | 'multi' | 'none';

interface LLMVerdict {
  chunk_index: number;
  confidence: LabelConfidence;
  secondary_indexes: number[];
}

interface RelabeledEntry {
  id: string;
  question: string;
  ground_truth_chunk_id: string;
  question_type: 'fact' | 'colloquial';
  label_confidence: LabelConfidence;
  secondary_chunk_ids: string[];
  source_chunk_preview: string;
}

const SYSTEM_PROMPT = `你是一个评估测试集校验器。给你一道用户问题和一组客服知识库片段(编号 0 到 N-1),你需要判断:这道题的答案出现在哪个或哪些片段里。

严格规则:
1. 只判断"答案是否明确出现在片段中",不要做发散推理。
2. 必须输出 JSON 对象,不要 markdown 包裹,不要解释文字。
3. 格式:{"chunk_index": <整数>, "confidence": "single"|"multi"|"none", "secondary_indexes": [<整数>...]}
4. 三种情形:
   · single = 答案只明确出现在一个片段 → chunk_index 填该编号,secondary_indexes 填 []
   · multi  = 多个片段都含答案 → chunk_index 填"信息最全/最主要"的那个,secondary_indexes 填其余编号
   · none   = 没有任何片段能直接回答这个问题 → chunk_index 填 -1,secondary_indexes 填 []
5. chunk_index 和 secondary_indexes 中的所有编号必须是 0 到 N-1 的整数(或 chunk_index=-1 表示 none)。
6. secondary_indexes 不得包含 chunk_index 自己,不得重复。`;

function shortId(id: string): string {
  return id.slice(0, 8);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[失败] 缺少环境变量 ${name}`);
    process.exit(1);
  }
  return v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

// JSON 容错(单对象版)三级降级:
// 1) 整段直接 parse(要求 isRecord,不是数组)
// 2) markdown 代码块 ```json ... ``` 提取
// 3) 抓首个 { ... }
function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    const v: unknown = JSON.parse(trimmed);
    if (isRecord(v)) return v;
  } catch {
    // 降级
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try {
      const v: unknown = JSON.parse(fenceMatch[1]);
      if (isRecord(v)) return v;
    } catch {
      // 降级
    }
  }
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      const v: unknown = JSON.parse(objectMatch[0]);
      if (isRecord(v)) return v;
    } catch {
      // 落到底
    }
  }
  throw new Error('无法从 LLM 返回中提取 JSON 对象');
}

function normalizeVerdict(parsed: unknown, chunkCount: number): LLMVerdict {
  if (!isRecord(parsed)) {
    throw new Error('LLM 返回不是 JSON 对象');
  }

  const rawConf = parsed.confidence;
  if (rawConf !== 'single' && rawConf !== 'multi' && rawConf !== 'none') {
    throw new Error(`confidence 异常:${String(rawConf)}`);
  }
  const confidence: LabelConfidence = rawConf;

  // chunk_index
  let chunk_index: number;
  if (confidence === 'none') {
    if (parsed.chunk_index !== -1) {
      console.warn(
        `  ⚠️ confidence=none 但 chunk_index=${String(parsed.chunk_index)},强制改为 -1`,
      );
    }
    chunk_index = -1;
  } else {
    if (!isIntInRange(parsed.chunk_index, 0, chunkCount - 1)) {
      throw new Error(`chunk_index 越界或非整数:${String(parsed.chunk_index)}`);
    }
    chunk_index = parsed.chunk_index;
  }

  // secondary_indexes
  const rawSec = parsed.secondary_indexes;
  if (!Array.isArray(rawSec)) {
    throw new Error('secondary_indexes 不是数组');
  }
  let secondary_indexes: number[];
  if (confidence === 'none' || confidence === 'single') {
    if (rawSec.length > 0) {
      console.warn(
        `  ⚠️ confidence=${confidence} 但 secondary_indexes 非空(${rawSec.length} 项),已清空`,
      );
    }
    secondary_indexes = [];
  } else {
    // multi:逐项校验 + 去重 + 排除自身
    const seen = new Set<number>();
    const cleaned: number[] = [];
    for (const item of rawSec) {
      if (!isIntInRange(item, 0, chunkCount - 1)) {
        throw new Error(`secondary_indexes 含越界或非整数项:${String(item)}`);
      }
      if (item === chunk_index) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      cleaned.push(item);
    }
    if (cleaned.length === 0) {
      console.warn('  ⚠️ confidence=multi 但有效 secondary 为 0,降级为 single');
      return { chunk_index, confidence: 'single', secondary_indexes: [] };
    }
    secondary_indexes = cleaned;
  }

  return { chunk_index, confidence, secondary_indexes };
}

// LangChain 1.x BaseMessage.content 可能是 string | MessageContentComplex[]
function getMessageContentAsString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isRecord(part) && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

function parseOriginalEntries(raw: string): OriginalEntry[] {
  const lines = raw.split(/\r?\n/);
  const out: OriginalEntry[] = [];
  lines.forEach((line, idx) => {
    const t = line.trim();
    if (!t) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`第 ${idx + 1} 行 JSON 解析失败:${msg}`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`第 ${idx + 1} 行不是 JSON 对象`);
    }
    const id = parsed.id;
    const question = parsed.question;
    const qt = parsed.question_type;
    const gt = parsed.ground_truth_chunk_id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`第 ${idx + 1} 行 id 缺失或非字符串`);
    }
    if (typeof question !== 'string' || question.length === 0) {
      throw new Error(`第 ${idx + 1} 行 question 缺失或非字符串`);
    }
    if (qt !== 'fact' && qt !== 'colloquial') {
      throw new Error(`第 ${idx + 1} 行 question_type 异常:${String(qt)}`);
    }
    if (typeof gt !== 'string') {
      throw new Error(`第 ${idx + 1} 行 ground_truth_chunk_id 非字符串`);
    }
    out.push({ id, question, question_type: qt, ground_truth_chunk_id: gt });
  });
  return out;
}

async function main(): Promise<void> {
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const siliconKey = requireEnv('SILICONFLOW_API_KEY');
  const siliconBase = requireEnv('SILICONFLOW_BASE_URL');

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const llm = new ChatOpenAI({
    model: MODEL,
    apiKey: siliconKey,
    configuration: { baseURL: siliconBase },
    temperature: TEMPERATURE,
  });

  console.log('V2 Step 22 阶段 2b — 重新定位评估测试集 ground truth');
  console.log(`TENANT_ID = ${TENANT_ID}`);
  console.log(`MODEL = ${MODEL}  temperature = ${TEMPERATURE}`);
  console.log(`输入 = ${INPUT_PATH}`);
  console.log(`输出 = ${OUTPUT_PATH}\n`);

  // ① 读 testset.jsonl
  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`[失败] 找不到输入文件 ${INPUT_PATH}`);
    process.exit(1);
  }
  const rawText = fs.readFileSync(INPUT_PATH, 'utf8');
  const entries = parseOriginalEntries(rawText);
  if (entries.length === 0) {
    console.error('[失败] 测试集为空');
    process.exit(1);
  }
  console.log(`读取到 ${entries.length} 道题\n`);

  // ② 查全部 chunks(READ-ONLY,显式 user_id 过滤)
  const chunkRes = await admin
    .from('document_chunks')
    .select('id, content')
    .eq('user_id', TENANT_ID)
    .order('created_at', { ascending: true })
    .returns<ChunkRow[]>();
  if (chunkRes.error) {
    console.error('[失败] 查询 document_chunks 出错', chunkRes.error);
    process.exit(1);
  }
  const chunks: ChunkRow[] = chunkRes.data ?? [];
  if (chunks.length === 0) {
    console.error('[失败] 账号 A 没有任何 chunk');
    process.exit(1);
  }
  const N = chunks.length;
  console.log(`扫描到 ${N} 个 chunk,稳定编号 0 到 ${N - 1}\n`);

  // ③ 构造编号映射 + 一次性拼好 chunks block(后续每题复用)
  const indexToChunkId = new Map<number, string>();
  chunks.forEach((c, i) => {
    indexToChunkId.set(i, c.id);
  });
  const chunksBlock = chunks
    .map((c, i) => `[chunk ${i}]\n${c.content}`)
    .join('\n\n');

  // ④ 逐题串行调 LLM
  const relabeled: RelabeledEntry[] = [];
  const failures: string[] = [];

  for (const [i, e] of entries.entries()) {
    const tag = `[${i + 1}/${entries.length}] ${e.id}`;
    let verdict: LLMVerdict;
    try {
      const userText =
        `问题:${e.question}\n\n` +
        `以下是 ${N} 个客服知识库片段(编号 0 到 ${N - 1}):\n\n` +
        `${chunksBlock}\n\n` +
        `请判断这道题的答案在哪个片段里,严格按要求输出 JSON。`;
      const res = await llm.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(userText),
      ]);
      const raw = getMessageContentAsString(res.content);
      const parsed = extractJsonObject(raw);
      verdict = normalizeVerdict(parsed, N);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${tag} → ⚠️ 处理失败,标 none:${msg}`);
      failures.push(e.id);
      verdict = { chunk_index: -1, confidence: 'none', secondary_indexes: [] };
    }

    // 映射回真实 chunk_id
    let newGt: string;
    let secondaryIds: string[];
    let preview: string;
    if (verdict.confidence === 'none' || verdict.chunk_index === -1) {
      newGt = '';
      secondaryIds = [];
      preview = NONE_PREVIEW;
    } else {
      const gtId = indexToChunkId.get(verdict.chunk_index);
      if (!gtId) {
        // 理论不达,normalizeVerdict 已做范围校验;防御性兜底
        console.warn(`${tag} → ⚠️ 索引 ${verdict.chunk_index} 映射失败,标 none`);
        verdict = { chunk_index: -1, confidence: 'none', secondary_indexes: [] };
        newGt = '';
        secondaryIds = [];
        preview = NONE_PREVIEW;
      } else {
        newGt = gtId;
        secondaryIds = verdict.secondary_indexes
          .map((idx) => indexToChunkId.get(idx))
          .filter((id): id is string => typeof id === 'string');
        preview = chunks[verdict.chunk_index].content.slice(0, PREVIEW_CHARS);
      }
    }

    relabeled.push({
      id: e.id,
      question: e.question,
      ground_truth_chunk_id: newGt,
      question_type: e.question_type,
      label_confidence: verdict.confidence,
      secondary_chunk_ids: secondaryIds,
      source_chunk_preview: preview,
    });

    const oldShort = e.ground_truth_chunk_id ? shortId(e.ground_truth_chunk_id) : '(空)';
    const newShort = newGt ? shortId(newGt) : '(none)';
    const changedMark = oldShort !== newShort ? '  (变更)' : '';
    console.log(
      `${tag} → ${verdict.confidence.padEnd(6)} | ${oldShort} → ${newShort}${changedMark}`,
    );
  }

  // ⑤ 写盘(只写本地;原 testset.jsonl 不动)
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const jsonl = relabeled.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(OUTPUT_PATH, jsonl, 'utf8');

  // ⑥ 变更报告
  console.log(`\n${'═'.repeat(60)}`);
  console.log('变更报告');
  console.log('═'.repeat(60));

  const changedEntries: { e: RelabeledEntry; oldGt: string }[] = [];
  const multiEntries: RelabeledEntry[] = [];
  const noneEntries: RelabeledEntry[] = [];

  relabeled.forEach((r, idx) => {
    const oldGt = entries[idx].ground_truth_chunk_id;
    if (r.ground_truth_chunk_id !== oldGt) {
      changedEntries.push({ e: r, oldGt });
    }
    if (r.label_confidence === 'multi') multiEntries.push(r);
    if (r.label_confidence === 'none') noneEntries.push(r);
  });

  console.log(`\n共处理 ${relabeled.length} 题`);

  console.log(`\n— ground truth 变化的题(共 ${changedEntries.length}):`);
  if (changedEntries.length === 0) {
    console.log('  (无)');
  } else {
    for (const { e, oldGt } of changedEntries) {
      const oldS = oldGt ? shortId(oldGt) : '(空)';
      const newS = e.ground_truth_chunk_id ? shortId(e.ground_truth_chunk_id) : '(none)';
      console.log(
        `  ${e.id}  ${oldS} → ${newS}  [${e.label_confidence}]  ${e.question}`,
      );
    }
  }

  console.log(
    `\n— confidence=multi 的题(共 ${multiEntries.length},供人工决定保留/删除):`,
  );
  if (multiEntries.length === 0) {
    console.log('  (无)');
  } else {
    for (const e of multiEntries) {
      const secStr = e.secondary_chunk_ids.map(shortId).join(', ');
      console.log(
        `  ${e.id}  主=${shortId(e.ground_truth_chunk_id)}  次=[${secStr}]  ${e.question}`,
      );
    }
  }

  console.log(
    `\n— confidence=none 的题(共 ${noneEntries.length},供人工决定删除):`,
  );
  if (noneEntries.length === 0) {
    console.log('  (无)');
  } else {
    for (const e of noneEntries) {
      console.log(`  ${e.id}  ${e.question}`);
    }
  }

  const singleCount = relabeled.filter((r) => r.label_confidence === 'single').length;
  console.log(
    `\n— confidence 分布:single=${singleCount} / multi=${multiEntries.length} / none=${noneEntries.length}`,
  );

  if (failures.length > 0) {
    console.log(
      `\n⚠️ LLM 调用 / JSON 解析失败的题(已标 none,共 ${failures.length}):`,
    );
    for (const id of failures) console.log(`  ${id}`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ 完成。写入 ${OUTPUT_PATH}`);
  console.log(`   原 ${INPUT_PATH} 未改动,可直接对照`);
}

main().catch((err) => {
  console.error('[失败]', err);
  process.exit(1);
});
