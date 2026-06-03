// V2 Step 26.4 — V2+Reranker 评估(口径 A:直接调底层检索 + Reranker,不跑 Agent / 不跑 LLM)
//
// ⚠️ 严禁写数据库:本文件不出现 .insert / .update / .delete / .upsert
//    只调 RPC match_document_chunks(只读)+ SiliconFlow /rerank(只读)
//    与 run-v2.ts(Step 25.2a)检索路径同源,唯一差异 = 召回 20 → rerank 5
//
// 与 run-v2.ts 的差异(刻意为之,用于隔离 rerank 的贡献):
//   ① match_count = RECALL_K=20(非 TOP_K=5)
//   ② 召回 20 条后,调 rerank-core.rerankDocuments(query, contents, FINAL_K=5)
//      精排出 5 条作为最终 retrieved 输出,字节级对齐 run-v2.ts 的 5 条 retrieved 结构
//   ③ RetrievedItem 新增 rerank_score 字段(rerank API 返回的 relevance_score)
//   ④ 输出 eval/results/v2-reranker.json,顶层 version: 'v2-reranker'
//   ⑤ model_config 扩展:recall_k / final_k / reranker_model
//
// 与 run-v2.ts 一致(硬约束,确保口径 A 同源):
//   - chunkHits / computeMRR 函数体字节级复制
//   - TENANT_ID / MIN_SIMILARITY / EMBEDDING_MODEL_NAME 常量一字不动
//   - 输入仍是 eval/testset-final.jsonl + eval/chapter-tags.json
//   - 命中规则一致:chunk 章节 tags 与 {gt, ...secondary} Set 交集非空即命中
//   - per_question / AggregateBucket 字段集与 V2 一致(+ 可选 rerank_score)
//
// ⚠️ 评估口径与生产相反(rerank 失败处理):
//   - 生产 lib/agent/tools.ts(Step 26.3):rerank 失败 → 静默回退 pgvector 召回前 5
//     目的:不让 reranker 服务抖动劣化客户体验
//   - 本评估脚本:rerank 失败 → 直接 throw,中止全脚本
//     目的:任何一题 rerank 没真跑都会污染对比口径,必须暴露不掩盖
//
// 30s 超时语义(RERANK_TIMEOUT_MS):
//   - 生产 tools.ts 是 3s 保终端用户体验
//   - 本脚本 30s 仅防 API 卡死兜底:rerank 20 条文档实测远 < 1s,正常不会触及
//   - 取向不同非 bug:延迟敏感 vs 评估完整性,边界值不同是设计选择
//
// 复刻而非 import:
//   - 不能 import lib/rag/rerank.ts(server-only,tsx 环境会报错;EXPERIENCE 主题 1.2)
//   - 直接 import lib/rag/rerank-core.ts(无 server-only,纯函数,允许)
//   - RERANK_MODEL 在本脚本定义为与 rerank.ts 同值的常量(评估自治,不依赖薄包装)
//
// 注意:tsx 脚本环境,不能加 'server-only';rerank API 需 SILICONFLOW_* 环境变量

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { embedTextsWithConfig, type EmbedConfig } from '../../lib/rag/embed-core';
import { rerankDocuments } from '../../lib/rag/rerank-core';

// ─── 常量 ───────────────────────────────────────────────
const TENANT_ID = 'afcd94f9-8a2f-4d5e-b4f3-36dee5e8320e'; // 与 run-v2.ts 一字不动
const RECALL_K = 20; // 召回数:扩大候选池,给 rerank 精排空间(Step 26.3 同值)
const FINAL_K = 5; // 精排后保留数:与 run-v2.ts 的 TOP_K=5 同,确保 retrieved 结构对齐
const MIN_SIMILARITY = 0.3; // 与 run-v2.ts 一字不动
const EMBEDDING_MODEL_NAME = 'BAAI/bge-m3'; // 与 embed-core.ts:10 同
const RERANK_MODEL = 'BAAI/bge-reranker-v2-m3'; // 与 lib/rag/rerank.ts 同值,评估自治
const RERANK_TIMEOUT_MS = 30000; // 30s 仅防 API 卡死兜底;正常 20 条 <1s 远不触及
const INPUT_TESTSET_PATH = 'eval/testset-final.jsonl';
const INPUT_TAGS_PATH = 'eval/chapter-tags.json';
const OUTPUT_PATH = 'eval/results/v2-reranker.json';

const COMPARISON_NOTE =
  'V2+reranker 与 V2 唯一差异 = 召回 20 → rerank 5;'
  + 'embedding=BAAI/bge-m3 / RPC=match_document_chunks / min_similarity=0.3 全部同源;'
  + '主指标看 Recall@1 + MRR(11 chunk 全集 Recall@5 失区分度,详见 EXPERIENCE 主题 13.4)。';

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
  rerank_score: number; // V2+reranker 新增:rerank API 返回的 relevance_score(覆盖度自证用)
}

interface PerQuestion {
  qid: string;
  question: string;
  question_type: QuestionType;
  ground_truth_chapter: string;
  secondary_chapters: string[];
  retrieved: RetrievedItem[];
  hit_at_1: boolean;
  hit_at_5: boolean;
  mrr: number;
}

interface AggregateBucket {
  n: number;
  recall_at_1: number;
  recall_at_5: number;
  mrr: number;
}

interface V2RerankerOutput {
  version: 'v2-reranker';
  tenant_id: string;
  model_config: {
    embedding: string;
    recall_k: number;
    final_k: number;
    reranker_model: string;
  };
  run_at: string;
  comparison_note: string;
  summary: {
    total_questions: number;
    recall_at_1_overall: number;
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

// ─── 解析输入(与 run-v2.ts 一致)───────────────────────
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

// ─── 检索:召回 RECALL_K 条(在 run-v2.ts 的 retrieveTopK 基础上把 match_count 改 RECALL_K)
async function retrieveRecallK(
  admin: SupabaseClient,
  embedConfig: EmbedConfig,
  question: string,
): Promise<RpcRow[]> {
  const vectors = await embedTextsWithConfig([question], embedConfig);
  const queryEmbedding = vectors[0];

  const { data, error } = await admin.rpc('match_document_chunks', {
    query_embedding: queryEmbedding,
    tenant_id: TENANT_ID,
    match_count: RECALL_K,
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

// ─── 命中规则(与 run-v2.ts 字节级一致)──────────────
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

// ─── 聚合(与 run-v2.ts 字节级一致)────────────────────
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
  console.log('V2 Step 26.4 — V2+Reranker 评估(口径 A:不跑 Agent / 不跑 LLM)');
  console.log('═'.repeat(70));
  console.log(`TENANT_ID = ${TENANT_ID}`);
  console.log(
    `embedding = ${EMBEDDING_MODEL_NAME}  recall_k = ${RECALL_K}  final_k = ${FINAL_K}  min_similarity = ${MIN_SIMILARITY}`,
  );
  console.log(`reranker = ${RERANK_MODEL}  timeout = ${RERANK_TIMEOUT_MS}ms(防 API 卡死兜底)`);
  console.log(`输入 = ${INPUT_TESTSET_PATH} + ${INPUT_TAGS_PATH}`);
  console.log(`输出 = ${OUTPUT_PATH}\n`);

  // 读入
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

  // 串行 retrieve(召回 20)+ rerank(精排 5)+ 评分
  const total = testset.length;
  const perQuestions: PerQuestion[] = [];
  const warnedMissingTags = new Set<string>();

  for (let i = 0; i < total; i++) {
    const e = testset[i];
    const tag = `[${String(i + 1).padStart(2)}/${total}] ${e.id}`;

    // 1) 召回 RECALL_K 条(retrieveRecallK 失败保留 run-v2.ts 的 warn+全 miss 容错)
    let recallRows: RpcRow[];
    try {
      recallRows = await retrieveRecallK(admin, embedConfig, e.question);
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

    // 2) Rerank:召回 RECALL_K → 精排 FINAL_K
    //    评估口径:rerank 失败 → 直接 throw 中止全脚本(与生产 tools.ts 静默回退相反)
    //    原因:任何一题 rerank 没真跑都会污染对比口径,必须暴露不掩盖
    let finalRows: RpcRow[];
    let rerankScores: number[]; // 与 finalRows 一一对齐,顺序为 rerank 排名
    if (recallRows.length === 0) {
      finalRows = [];
      rerankScores = [];
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);
      try {
        const reranked = await rerankDocuments({
          apiKey: siliconKey,
          baseURL: siliconBase,
          model: RERANK_MODEL,
          query: e.question,
          documents: recallRows.map((r) => r.content),
          topN: FINAL_K,
          signal: controller.signal,
        });
        // rerank-core 已按 relevance_score 降序,直接 map
        finalRows = reranked.map((rr) => recallRows[rr.index]);
        rerankScores = reranked.map((rr) => rr.relevanceScore);
      } catch (err) {
        // 评估口径:抛错中止,不静默回退;不写 perQuestions、不 continue
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[${tag}] rerank 失败,评估口径要求中止脚本(生产是静默回退,本脚本是抛错):${msg}`,
        );
      } finally {
        clearTimeout(timer);
      }
    }

    // 3) 评分(命中规则与 run-v2.ts 一致)
    const retrieved: RetrievedItem[] = [];
    const hits: boolean[] = [];
    finalRows.forEach((r, rIdx) => {
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
        rerank_score: round4(rerankScores[rIdx]),
      });
    });

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
    const top1Score = retrieved[0]?.rerank_score ?? 0;
    console.log(
      `${tag} → hit@1=${hit1Str}  hit@5=${hit5Str}  mrr=${mrr.toFixed(4)}  rerank_top1=${top1Score.toFixed(4)}  gt=${e.ground_truth_chapter}${missMark}`,
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

  const out: V2RerankerOutput = {
    version: 'v2-reranker',
    tenant_id: TENANT_ID,
    model_config: {
      embedding: EMBEDDING_MODEL_NAME,
      recall_k: RECALL_K,
      final_k: FINAL_K,
      reranker_model: RERANK_MODEL,
    },
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

  // 打印 summary
  console.log(`\n${'═'.repeat(70)}`);
  console.log('V2+Reranker 评估结果(口径 A,与 V1/V2 同源命中规则)');
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

  // Rerank 覆盖度自证:全 44 题 top-1 rerank_score 分布
  // 设计目的:反向证明 rerank 在 44 题全样本都真跑了
  //   - 若某题 top1Score == 0(且不是因 retrieve 失败),说明 rerank 没生效
  //   - min/max/median 反映 rerank 给出的相关性区间
  const top1Scores = perQuestions
    .map((q) => q.retrieved[0]?.rerank_score)
    .filter((s): s is number => typeof s === 'number');
  if (top1Scores.length > 0) {
    const sorted = [...top1Scores].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    console.log('\n— Rerank 覆盖度自证(全 44 题 top-1 rerank_score 分布)');
    console.log(
      `  样本:${top1Scores.length}/${total}  min=${round4(min).toFixed(4)}  median=${round4(median).toFixed(4)}  max=${round4(max).toFixed(4)}`,
    );
    const zeroCount = top1Scores.filter((s) => s === 0).length;
    if (zeroCount > 0) {
      console.warn(
        `  ⚠️ 有 ${zeroCount} 题 top1 rerank_score 为 0,可能未真跑 rerank,请核查`,
      );
    } else {
      console.log('  ✓ 无 0 值,rerank 在全样本均生效');
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`✅ 写入 ${OUTPUT_PATH}`);
  console.log('═'.repeat(70));
}

main().catch((err) => {
  console.error('[失败]', err);
  process.exit(1);
});
