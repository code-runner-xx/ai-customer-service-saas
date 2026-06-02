// V2 Step 25.2a — V2 评估(口径 A:直接调底层检索,不跑 Agent)
//
// ⚠️ 严禁写数据库:本文件不出现 .insert / .update / .delete / .upsert
//    只调 RPC match_document_chunks(只读),与 V1 baseline 检索路径字节级同源
//    (同一 embedding 模型 + 同一 RPC + 同一 top_k + 同一 min_similarity)
//
// 与 run-v1-baseline.ts 的差异(刻意为之):
//   ① 输出 eval/results/v2.json
//   ② 顶层 version: 'v2' + comparison_note
//   ③ summary 新增 recall_at_1_overall;AggregateBucket 新增 recall_at_1 字段
//   ④ per_question 新增 hit_at_1 = retrieved[0]?.hit ?? false
//      (Recall@1 口径:rank=1 命中即算,不是 mrr==1.0)
//
// 与 V1 baseline 一致(硬约束):
//   - retrieveTopK / chunkHits / computeMRR 函数体字节级复制
//   - TENANT_ID / TOP_K / MIN_SIMILARITY / EMBEDDING_MODEL_NAME 常量一字不动
//   - 输入仍是 eval/testset-final.jsonl + eval/chapter-tags.json
//   - 命中规则一致:chunk 章节 tags 与 {gt, ...secondary} Set 交集非空即命中
//
// 注意:tsx 脚本环境,不能加 'server-only'(EXPERIENCE 主题 1.2)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { embedTextsWithConfig, type EmbedConfig } from '../../lib/rag/embed-core';

// ─── 常量(与 V1 baseline 一字不动)─────────────────────
const TENANT_ID = 'afcd94f9-8a2f-4d5e-b4f3-36dee5e8320e';
const TOP_K = 5;
const MIN_SIMILARITY = 0.3; // 显式传,不依赖 SQL 默认值(规划者要求)
const EMBEDDING_MODEL_NAME = 'BAAI/bge-m3'; // 与 embed-core.ts:10 同
const INPUT_TESTSET_PATH = 'eval/testset-final.jsonl';
const INPUT_TAGS_PATH = 'eval/chapter-tags.json';
const OUTPUT_PATH = 'eval/results/v2.json';

const COMPARISON_NOTE =
  'V2 检索算法与 V1 baseline 同源(embedding=BAAI/bge-m3、RPC=match_document_chunks、top_k=5、min_similarity=0.3 一致),'
  + '数字一致为预期,证明 Agent 化未劣化检索;'
  + 'Agent 升级价值在工具调用/降级/可观测,由其他评估覆盖。';

// ─── 类型 ───────────────────────────────────────────────
type QuestionType = 'fact' | 'colloquial';

interface TestsetEntry {
  id: string;
  question: string;
  question_type: QuestionType;
  ground_truth_chapter: string;
  secondary_chapters: string[];
  source_chunk_preview: string;
}

interface RpcRow {
  id: string;
  document_id: string;
  content: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

interface RetrievedItem {
  rank: number;
  chunk_id: string;
  chunk_short_id: string;
  chapter_tags: string[];
  similarity: number;
  hit: boolean;
}

interface PerQuestion {
  qid: string;
  question: string;
  question_type: QuestionType;
  ground_truth_chapter: string;
  secondary_chapters: string[];
  retrieved: RetrievedItem[];
  hit_at_1: boolean; // V2 新增:rank=1 那一条是否命中
  hit_at_5: boolean;
  mrr: number;
}

interface AggregateBucket {
  n: number;
  recall_at_1: number; // V2 新增
  recall_at_5: number;
  mrr: number;
}

interface V2Output {
  version: 'v2'; // V2 新增
  tenant_id: string;
  model_config: { embedding: string; top_k: number };
  run_at: string;
  comparison_note: string; // V2 新增
  summary: {
    total_questions: number;
    recall_at_1_overall: number; // V2 新增
    recall_at_5_overall: number;
    mrr_overall: number;
    by_question_type: Record<QuestionType, AggregateBucket>;
    by_chapter: Record<string, AggregateBucket>;
  };
  per_question: PerQuestion[];
}

// ─── 工具 ───────────────────────────────────────────────
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

function round4(x: number): number {
  return Number(x.toFixed(4));
}

function chapterNum(code: string): number {
  const m = code.match(/^(\d+)-/);
  return m ? parseInt(m[1], 10) : 9999;
}

// ─── 解析输入(与 V1 baseline 一致)─────────────────────
function parseTestset(raw: string): TestsetEntry[] {
  const lines = raw.split(/\r?\n/);
  const out: TestsetEntry[] = [];
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
    const gt = parsed.ground_truth_chapter;
    const sec = parsed.secondary_chapters;
    const preview = parsed.source_chunk_preview;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`第 ${idx + 1} 行 id 缺失或非字符串`);
    }
    if (typeof question !== 'string' || question.length === 0) {
      throw new Error(`第 ${idx + 1} 行 question 缺失或非字符串`);
    }
    if (qt !== 'fact' && qt !== 'colloquial') {
      throw new Error(`第 ${idx + 1} 行 question_type 异常:${String(qt)}`);
    }
    if (typeof gt !== 'string' || gt.length === 0) {
      throw new Error(`第 ${idx + 1} 行 ground_truth_chapter 缺失或非字符串`);
    }
    if (!Array.isArray(sec)) {
      throw new Error(`第 ${idx + 1} 行 secondary_chapters 不是数组`);
    }
    const secondary: string[] = [];
    for (const s of sec) {
      if (typeof s !== 'string') {
        throw new Error(`第 ${idx + 1} 行 secondary_chapters 含非字符串项`);
      }
      secondary.push(s);
    }
    if (typeof preview !== 'string') {
      throw new Error(`第 ${idx + 1} 行 source_chunk_preview 非字符串`);
    }
    out.push({
      id,
      question,
      question_type: qt,
      ground_truth_chapter: gt,
      secondary_chapters: secondary,
      source_chunk_preview: preview,
    });
  });
  return out;
}

function parseChapterTags(raw: string): Record<string, string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`chapter-tags.json 解析失败:${msg}`);
  }
  if (!isRecord(parsed)) {
    throw new Error('chapter-tags.json 不是 JSON 对象');
  }
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!Array.isArray(v)) {
      throw new Error(`chapter-tags.json 中 ${k} 的值不是数组`);
    }
    const tags: string[] = [];
    for (const t of v) {
      if (typeof t !== 'string') {
        throw new Error(`chapter-tags.json 中 ${k} 含非字符串项`);
      }
      tags.push(t);
    }
    out[k] = tags;
  }
  return out;
}

// ─── 检索:与 V1 baseline 字节级一致(硬约束 1)──────────
async function retrieveTopK(
  admin: SupabaseClient,
  embedConfig: EmbedConfig,
  question: string,
): Promise<RpcRow[]> {
  const vectors = await embedTextsWithConfig([question], embedConfig);
  const queryEmbedding = vectors[0];

  const { data, error } = await admin.rpc('match_document_chunks', {
    query_embedding: queryEmbedding,
    tenant_id: TENANT_ID,
    match_count: TOP_K,
    min_similarity: MIN_SIMILARITY,
  });
  if (error) {
    throw new Error(`向量检索失败:${error.message}`);
  }
  const rows: unknown = data ?? [];
  if (!Array.isArray(rows)) {
    throw new Error('match_document_chunks 返回非数组');
  }
  return rows as RpcRow[];
}

// ─── 命中规则(与 V1 baseline 字节级一致)──────────────
function chunkHits(
  chunkTags: string[] | undefined,
  gt: string,
  secondary: string[],
): boolean {
  if (!chunkTags || chunkTags.length === 0) return false;
  const targets = new Set<string>([gt, ...secondary]);
  return chunkTags.some((t) => targets.has(t));
}

function computeMRR(hits: boolean[]): number {
  for (let i = 0; i < hits.length; i++) {
    if (hits[i]) return 1 / (i + 1);
  }
  return 0;
}

// ─── 聚合(在 V1 基础上叠加 recall_at_1)────────────────
function aggregate(qs: PerQuestion[]): AggregateBucket {
  const n = qs.length;
  if (n === 0) return { n: 0, recall_at_1: 0, recall_at_5: 0, mrr: 0 };
  const hit1Count = qs.filter((q) => q.hit_at_1).length;
  const hit5Count = qs.filter((q) => q.hit_at_5).length;
  const mrrSum = qs.reduce((s, q) => s + q.mrr, 0);
  return {
    n,
    recall_at_1: round4(hit1Count / n),
    recall_at_5: round4(hit5Count / n),
    mrr: round4(mrrSum / n),
  };
}

// ─── 主流程 ────────────────────────────────────────────
async function main(): Promise<void> {
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const siliconKey = requireEnv('SILICONFLOW_API_KEY');
  const siliconBase = requireEnv('SILICONFLOW_BASE_URL');

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const embedConfig: EmbedConfig = { apiKey: siliconKey, baseURL: siliconBase };

  console.log('═'.repeat(70));
  console.log('V2 Step 25.2a — V2 评估(口径 A:直接调底层检索,不跑 Agent)');
  console.log('═'.repeat(70));
  console.log(`TENANT_ID = ${TENANT_ID}`);
  console.log(
    `embedding = ${EMBEDDING_MODEL_NAME}  top_k = ${TOP_K}  min_similarity = ${MIN_SIMILARITY}`,
  );
  console.log(`输入 = ${INPUT_TESTSET_PATH} + ${INPUT_TAGS_PATH}`);
  console.log(`输出 = ${OUTPUT_PATH}\n`);

  // 读入(三样输入文件 fs.existsSync 兜底)
  if (!fs.existsSync(INPUT_TESTSET_PATH)) {
    console.error(`[失败] 找不到 ${INPUT_TESTSET_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(INPUT_TAGS_PATH)) {
    console.error(`[失败] 找不到 ${INPUT_TAGS_PATH}`);
    process.exit(1);
  }
  const testset = parseTestset(fs.readFileSync(INPUT_TESTSET_PATH, 'utf8'));
  const chapterTags = parseChapterTags(fs.readFileSync(INPUT_TAGS_PATH, 'utf8'));
  if (testset.length === 0) {
    console.error('[失败] testset 为空');
    process.exit(1);
  }
  console.log(
    `读取到 ${testset.length} 道题,${Object.keys(chapterTags).length} 个 chunk 章节标签\n`,
  );

  // 串行 retrieve + 评分
  const total = testset.length;
  const perQuestions: PerQuestion[] = [];
  const warnedMissingTags = new Set<string>();

  for (let i = 0; i < total; i++) {
    const e = testset[i];
    const tag = `[${String(i + 1).padStart(2)}/${total}] ${e.id}`;
    let rows: RpcRow[];
    try {
      rows = await retrieveTopK(admin, embedConfig, e.question);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${tag} → ⚠️ retrieve 失败:${msg}  视为全 miss`);
      perQuestions.push({
        qid: e.id,
        question: e.question,
        question_type: e.question_type,
        ground_truth_chapter: e.ground_truth_chapter,
        secondary_chapters: [...e.secondary_chapters],
        retrieved: [],
        hit_at_1: false,
        hit_at_5: false,
        mrr: 0,
      });
      continue;
    }

    const retrieved: RetrievedItem[] = [];
    const hits: boolean[] = [];
    rows.forEach((r, rIdx) => {
      const tags = chapterTags[r.id];
      if (!tags && !warnedMissingTags.has(r.id)) {
        console.warn(
          `  ⚠️ chunk ${shortId(r.id)} 不在 chapter-tags.json 中,视为不命中`,
        );
        warnedMissingTags.add(r.id);
      }
      const hit = chunkHits(tags, e.ground_truth_chapter, e.secondary_chapters);
      hits.push(hit);
      retrieved.push({
        rank: rIdx + 1,
        chunk_id: r.id,
        chunk_short_id: shortId(r.id),
        chapter_tags: tags ?? [],
        similarity: round4(r.similarity),
        hit,
      });
    });

    // V2 Recall@1 口径:rank=1 那一条是否命中(对齐 HANDOFF 0.9318 = 41/44 的口径)
    const hitAt1 = retrieved[0]?.hit ?? false;
    const hitAt5 = hits.some((h) => h);
    const mrr = computeMRR(hits);

    perQuestions.push({
      qid: e.id,
      question: e.question,
      question_type: e.question_type,
      ground_truth_chapter: e.ground_truth_chapter,
      secondary_chapters: [...e.secondary_chapters],
      retrieved,
      hit_at_1: hitAt1,
      hit_at_5: hitAt5,
      mrr: round4(mrr),
    });

    const hit1Str = hitAt1 ? 'true ' : 'false';
    const hit5Str = hitAt5 ? 'true ' : 'false';
    const missMark = hitAt5 ? '' : '  ⚠️ miss';
    console.log(
      `${tag} → hit@1=${hit1Str}  hit@5=${hit5Str}  mrr=${mrr.toFixed(4)}  gt=${e.ground_truth_chapter}${missMark}`,
    );
  }

  // 聚合 summary
  const overallHit1 = perQuestions.filter((q) => q.hit_at_1).length;
  const overallHit5 = perQuestions.filter((q) => q.hit_at_5).length;
  const overallMrrSum = perQuestions.reduce((s, q) => s + q.mrr, 0);
  const recall1Overall = overallHit1 / total;
  const recall5Overall = overallHit5 / total;
  const mrrOverall = overallMrrSum / total;

  const byQt: Record<QuestionType, AggregateBucket> = {
    fact: aggregate(perQuestions.filter((q) => q.question_type === 'fact')),
    colloquial: aggregate(
      perQuestions.filter((q) => q.question_type === 'colloquial'),
    ),
  };

  const chapterMap = new Map<string, PerQuestion[]>();
  for (const q of perQuestions) {
    const list = chapterMap.get(q.ground_truth_chapter) ?? [];
    list.push(q);
    chapterMap.set(q.ground_truth_chapter, list);
  }
  const sortedChapterKeys = [...chapterMap.keys()].sort(
    (a, b) => chapterNum(a) - chapterNum(b),
  );
  const byChapter: Record<string, AggregateBucket> = {};
  for (const ch of sortedChapterKeys) {
    const list = chapterMap.get(ch);
    if (!list) continue;
    byChapter[ch] = aggregate(list);
  }

  const out: V2Output = {
    version: 'v2',
    tenant_id: TENANT_ID,
    model_config: { embedding: EMBEDDING_MODEL_NAME, top_k: TOP_K },
    run_at: new Date().toISOString(),
    comparison_note: COMPARISON_NOTE,
    summary: {
      total_questions: total,
      recall_at_1_overall: round4(recall1Overall),
      recall_at_5_overall: round4(recall5Overall),
      mrr_overall: round4(mrrOverall),
      by_question_type: byQt,
      by_chapter: byChapter,
    },
    per_question: perQuestions,
  };

  // 写盘
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');

  // 打印 summary(只 dump V2 自己,不打印 V1↔V2 对比,留 25.2b)
  console.log(`\n${'═'.repeat(70)}`);
  console.log('V2 评估结果(口径 A,与 V1 baseline 同口径)');
  console.log('═'.repeat(70));
  console.log(`总题数:        ${total}`);
  console.log(
    `Recall@1:      ${round4(recall1Overall).toFixed(4)}  (${overallHit1}/${total} 命中)`,
  );
  console.log(
    `Recall@5:      ${round4(recall5Overall).toFixed(4)}  (${overallHit5}/${total} 命中)`,
  );
  console.log(`MRR:           ${round4(mrrOverall).toFixed(4)}\n`);

  console.log('— 按 question_type');
  console.log(
    `  fact         n=${String(byQt.fact.n).padStart(2)}  Recall@1=${byQt.fact.recall_at_1.toFixed(4)}  Recall@5=${byQt.fact.recall_at_5.toFixed(4)}  MRR=${byQt.fact.mrr.toFixed(4)}`,
  );
  console.log(
    `  colloquial   n=${String(byQt.colloquial.n).padStart(2)}  Recall@1=${byQt.colloquial.recall_at_1.toFixed(4)}  Recall@5=${byQt.colloquial.recall_at_5.toFixed(4)}  MRR=${byQt.colloquial.mrr.toFixed(4)}\n`,
  );

  console.log('— 按 ground_truth_chapter(章节代码升序)');
  for (const ch of sortedChapterKeys) {
    const b = byChapter[ch];
    console.log(
      `  ${ch.padEnd(16)} n=${String(b.n).padStart(2)}  Recall@1=${b.recall_at_1.toFixed(4)}  Recall@5=${b.recall_at_5.toFixed(4)}  MRR=${b.mrr.toFixed(4)}`,
    );
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`✅ 写入 ${OUTPUT_PATH}`);
  console.log('═'.repeat(70));
}

main().catch((err) => {
  console.error('[失败]', err);
  process.exit(1);
});
