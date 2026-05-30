// V2 Step 22 阶段 2b — 一次性诊断脚本:验证 q017 的 overlap 假说
//
// ⚠️ 严禁写数据库:只读 document_chunks
// 跑完即弃 / 可保留作 debug 工具
// 不动 scripts/eval/relabel-ground-truth.ts 一个字
//
// 注意:tsx 脚本环境,不能加 'server-only'(EXPERIENCE 主题 1.2)

import { createClient } from '@supabase/supabase-js';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';

// ─── 常量(与报备对齐)────────────────────────────────────────
const TENANT_ID = 'afcd94f9-8a2f-4d5e-b4f3-36dee5e8320e';
const TARGET_QID = 'q017';
const TARGET_QUESTION = 'X10 机器人最多可以记忆几层楼的地图?';
const OLD_GT_ID = '2f4d7a0f-d7b2-47d8-8926-9ffa0a657e2c'; // 阶段 2a 旧
const NEW_GT_ID = 'bac87e67-1f9c-429f-b938-084aec3158c9'; // 阶段 2b 新
const ANSWER_NEEDLE = 'X10 支持多达三层楼的地图记忆';
const OVERLAP_CHARS = 150;
const MODEL = 'deepseek-ai/DeepSeek-V3';
const TEMPERATURE = 0.3;

// ─── 类型(与 relabel-ground-truth.ts 同款)────────────────
interface ChunkRow {
  id: string;
  content: string;
}

type LabelConfidence = 'single' | 'multi' | 'none';

interface LLMVerdict {
  chunk_index: number;
  confidence: LabelConfidence;
  secondary_indexes: number[];
}

// ─── SYSTEM_PROMPT(逐字复制自 relabel-ground-truth.ts)────
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

// ─── 工具函数(与 relabel-ground-truth.ts 同款)──────────
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

// ─── 主流程 ────────────────────────────────────────────
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

  console.log('═'.repeat(70));
  console.log(`V2 Step 22 阶段 2b 诊断 — ${TARGET_QID}`);
  console.log('═'.repeat(70));
  console.log(`question      = ${TARGET_QUESTION}`);
  console.log(`OLD_GT_ID     = ${OLD_GT_ID}`);
  console.log(`NEW_GT_ID     = ${NEW_GT_ID}`);
  console.log(`ANSWER_NEEDLE = ${ANSWER_NEEDLE}`);
  console.log(`MODEL = ${MODEL}  temperature = ${TEMPERATURE}\n`);

  // 查 chunks(与 relabel-ground-truth.ts 同款查询)
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

  // ────────────────────────────────────────────────────
  // 段 ① 11 个 chunk 概览表
  // ────────────────────────────────────────────────────
  console.log('━'.repeat(70));
  console.log(`段 ① — chunks 数组概览(共 ${N} 个,按 created_at 升序)`);
  console.log('━'.repeat(70));
  for (const [i, c] of chunks.entries()) {
    const head = c.content.slice(0, 60).replace(/\s+/g, ' ');
    const tail = c.content.slice(-60).replace(/\s+/g, ' ');
    console.log(`\n  [${String(i).padStart(2)}]  ${shortId(c.id)}  length=${c.content.length}`);
    console.log(`         首60字: ${head}`);
    console.log(`         末60字: ${tail}`);
  }

  // ────────────────────────────────────────────────────
  // 段 ② 目标 chunk 定位
  // ────────────────────────────────────────────────────
  console.log(`\n${'━'.repeat(70)}`);
  console.log('段 ② — 目标 chunk 在 chunks 数组中的 index');
  console.log('━'.repeat(70));
  const oldIndex = chunks.findIndex((c) => c.id === OLD_GT_ID);
  const newIndex = chunks.findIndex((c) => c.id === NEW_GT_ID);
  console.log(`OLD_GT_ID (${shortId(OLD_GT_ID)})  index = ${oldIndex}`);
  console.log(`NEW_GT_ID (${shortId(NEW_GT_ID)})  index = ${newIndex}`);
  if (oldIndex !== -1 && newIndex !== -1) {
    const diff = oldIndex - newIndex;
    console.log(`差值 OLD - NEW = ${diff}  (假说预期 = 1)`);
    if (diff === 1) {
      console.log('✅ 假说前置成立:NEW 正好是 OLD 在 chunks 数组里的前一个');
    } else {
      console.log(`⚠️ 假说前置不成立:差值不是 1`);
    }
  } else {
    console.log('⚠️ OLD 或 NEW 不在 chunks 数组里(理论不应发生)');
  }

  // ────────────────────────────────────────────────────
  // 段 ③ overlap 验证(关键)
  // ────────────────────────────────────────────────────
  console.log(`\n${'━'.repeat(70)}`);
  console.log('段 ③ — overlap 边界对比');
  console.log('━'.repeat(70));
  if (oldIndex !== -1 && newIndex === oldIndex - 1) {
    const K = oldIndex;
    const newContent = chunks[K - 1].content;
    const oldContent = chunks[K].content;
    const newTail = newContent.slice(-OVERLAP_CHARS);
    const oldHead = oldContent.slice(0, OVERLAP_CHARS);

    console.log(`\nchunks[${K - 1}] (NEW = ${shortId(NEW_GT_ID)}) 的末尾 ${OVERLAP_CHARS} 字:`);
    console.log('═'.repeat(70));
    console.log(newTail);
    console.log('═'.repeat(70));

    console.log(`\nchunks[${K}] (OLD = ${shortId(OLD_GT_ID)}) 的开头 ${OVERLAP_CHARS} 字:`);
    console.log('═'.repeat(70));
    console.log(oldHead);
    console.log('═'.repeat(70));

    const strictlyEqual = newTail === oldHead;
    console.log(`\n字面严格相同(strict equality)? ${strictlyEqual ? '✅ true' : '❌ false'}`);

    // 检查 ANSWER_NEEDLE 是否出现在 NEW 的末尾 250 字内
    const newTailExt = newContent.slice(-250);
    const needleInNewTail = newTailExt.includes(ANSWER_NEEDLE);
    console.log(
      `"${ANSWER_NEEDLE}" 是否出现在 NEW 的末尾 250 字? ${needleInNewTail ? '✅ true' : '❌ false'}`,
    );
    const needleInNewWhole = newContent.includes(ANSWER_NEEDLE);
    console.log(
      `"${ANSWER_NEEDLE}" 是否出现在 NEW 整个 content 内? ${needleInNewWhole ? '✅ true(假说彻底坐实)' : '❌ false'}`,
    );
    const needleInOldHead = oldContent.slice(0, 250).includes(ANSWER_NEEDLE);
    console.log(
      `"${ANSWER_NEEDLE}" 是否出现在 OLD 的开头 250 字? ${needleInOldHead ? '✅ true' : '❌ false'}`,
    );
  } else {
    console.log('假说前置(diff=1)不成立,跳过 overlap 检查');
  }

  // ────────────────────────────────────────────────────
  // 段 ④ 完整 prompt 复刻
  // ────────────────────────────────────────────────────
  const chunksBlock = chunks
    .map((c, i) => `[chunk ${i}]\n${c.content}`)
    .join('\n\n');
  const userText =
    `问题:${TARGET_QUESTION}\n\n` +
    `以下是 ${N} 个客服知识库片段(编号 0 到 ${N - 1}):\n\n` +
    `${chunksBlock}\n\n` +
    `请判断这道题的答案在哪个片段里,严格按要求输出 JSON。`;

  console.log(`\n${'━'.repeat(70)}`);
  console.log('段 ④ — 完整 prompt(逐字复刻 relabel-ground-truth.ts 的拼接)');
  console.log('━'.repeat(70));
  console.log('\n========== SYSTEM ==========');
  console.log(SYSTEM_PROMPT);
  console.log('\n========== USER ==========');
  console.log(userText);
  console.log('========== END USER ==========');

  // ────────────────────────────────────────────────────
  // 段 ⑤ LLM 实跑结果
  // ────────────────────────────────────────────────────
  console.log(`\n${'━'.repeat(70)}`);
  console.log('段 ⑤ — LLM 实跑结果');
  console.log('━'.repeat(70));
  console.log('调用 LLM 中...\n');

  const res = await llm.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(userText),
  ]);
  const raw = getMessageContentAsString(res.content);

  console.log('LLM 原始返回(逐字字符串):');
  console.log('─'.repeat(70));
  console.log(raw);
  console.log('─'.repeat(70));

  let parsed: unknown;
  try {
    parsed = extractJsonObject(raw);
    console.log('\nextractJsonObject 解析结果(JSON.stringify):');
    console.log(JSON.stringify(parsed, null, 2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n⚠️ extractJsonObject 失败:${msg}`);
    return;
  }

  let verdict: LLMVerdict;
  try {
    verdict = normalizeVerdict(parsed, N);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n⚠️ normalizeVerdict 失败:${msg}`);
    return;
  }

  console.log('\nnormalizeVerdict 结果:');
  console.log(`  chunk_index        = ${verdict.chunk_index}`);
  console.log(`  confidence         = ${verdict.confidence}`);
  console.log(`  secondary_indexes  = [${verdict.secondary_indexes.join(', ')}]`);

  if (verdict.confidence === 'none' || verdict.chunk_index === -1) {
    console.log('\n映射回 chunk_id:(none,无定位)');
  } else {
    const mappedId = chunks[verdict.chunk_index].id;
    const mappedContent = chunks[verdict.chunk_index].content;
    let label: string;
    if (mappedId === OLD_GT_ID) label = 'OLD_GT(阶段 2a 旧值)';
    else if (mappedId === NEW_GT_ID) label = 'NEW_GT(阶段 2b 新值)';
    else label = '其他 chunk';
    console.log(`\n映射回 chunk_id:${mappedId}`);
    console.log(`  ↳ 该 chunk_id 是:${label}`);
    console.log(`  ↳ chunks[${verdict.chunk_index}].content 前 100 字:`);
    console.log(`     ${mappedContent.slice(0, 100).replace(/\s+/g, ' ')}`);
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log('✅ 诊断完成。数据库无任何写操作。');
  console.log('═'.repeat(70));
}

main().catch((err) => {
  console.error('[失败]', err);
  process.exit(1);
});
