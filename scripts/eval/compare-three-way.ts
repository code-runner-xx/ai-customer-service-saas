// V2 Step 26.4 — V1↔V2↔V2+Reranker 三方检索质量对比脚本(纯文件运算)
//
// ⚠️ 严禁写数据库 / 调外部 API:本文件不出现 .insert / .update / fetch / rpc
//    只读 eval/results/v1-baseline.json + eval/results/v2.json + eval/results/v2-reranker.json
//    产出控制台对比表 + eval/results/v1-v2-reranker-report.md(.gitignore,不进 git)
//
// ★ 关键设计(承袭 compare-v1-v2.ts):
//   - V1 Recall@1 从 v1.per_question[i].retrieved[0]?.hit ?? false 现算
//     (overall + by_question_type + by_chapter 三层都现算)
//   - V2 / V2+reranker Recall@1 直接读 summary.recall_at_1_overall / bucket.recall_at_1
//   - 三方底层口径都是"rank=1 那个 chunk 是否命中" = retrieved[0].hit
//     → 字节级同口径,可直接对比
//   - 绝不访问 v1.summary.recall_at_1_overall(该字段不存在)
//
// 主指标依据:EXPERIENCE 主题 13.4(11 chunk 全集下 Recall@5 失区分度,主指标 Recall@1 + MRR)
// V1 baseline 数字依据:HANDOFF 第六节 Step 22(Recall@1=0.9318 / Recall@5=1.0 / MRR=0.9602)
//
// Rerank 覆盖度自证:对 V2+reranker 全 44 题 top-1 rerank_score 求 min/median/max,
// 反向证明 rerank 在全样本都真跑了(若 top1Score=0 则该题 rerank 未生效)
//
// 注意:tsx 脚本环境,不能加 'server-only'(EXPERIENCE 主题 1.2);纯文件运算无需 --env-file

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── 常量 ───────────────────────────────────────────────
const V1_PATH = 'eval/results/v1-baseline.json';
const V2_PATH = 'eval/results/v2.json';
const V2R_PATH = 'eval/results/v2-reranker.json';
const REPORT_PATH = 'eval/results/v1-v2-reranker-report.md';

// ─── 类型 ───────────────────────────────────────────────
type QuestionType = 'fact' | 'colloquial';

interface RetrievedItem {
  rank: number;
  chunk_id: string;
  chunk_short_id: string;
  chapter_tags: string[];
  similarity: number;
  hit: boolean;
}

interface RetrievedItemR extends RetrievedItem {
  rerank_score: number; // V2+reranker 独有
}

interface PerQuestionV1 {
  qid: string;
  question: string;
  question_type: QuestionType;
  ground_truth_chapter: string;
  secondary_chapters: string[];
  retrieved: RetrievedItem[];
  hit_at_5: boolean;
  mrr: number;
  // ⚠️ V1 无 hit_at_1 字段
}

interface PerQuestionV2 {
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

interface PerQuestionV2R {
  qid: string;
  question: string;
  question_type: QuestionType;
  ground_truth_chapter: string;
  secondary_chapters: string[];
  retrieved: RetrievedItemR[];
  hit_at_1: boolean;
  hit_at_5: boolean;
  mrr: number;
}

interface AggregateBucketV1 {
  n: number;
  recall_at_5: number;
  mrr: number;
}

interface AggregateBucketV2 {
  n: number;
  recall_at_1: number;
  recall_at_5: number;
  mrr: number;
}

interface BaselineJsonV1 {
  tenant_id: string;
  model_config: { embedding: string; top_k: number };
  run_at: string;
  summary: {
    total_questions: number;
    recall_at_5_overall: number;
    mrr_overall: number;
    by_question_type: Record<QuestionType, AggregateBucketV1>;
    by_chapter: Record<string, AggregateBucketV1>;
  };
  per_question: PerQuestionV1[];
}

interface V2Json {
  version: 'v2';
  tenant_id: string;
  model_config: { embedding: string; top_k: number };
  run_at: string;
  comparison_note: string;
  summary: {
    total_questions: number;
    recall_at_1_overall: number;
    recall_at_5_overall: number;
    mrr_overall: number;
    by_question_type: Record<QuestionType, AggregateBucketV2>;
    by_chapter: Record<string, AggregateBucketV2>;
  };
  per_question: PerQuestionV2[];
}

interface V2RerankerJson {
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
    by_question_type: Record<QuestionType, AggregateBucketV2>;
    by_chapter: Record<string, AggregateBucketV2>;
  };
  per_question: PerQuestionV2R[];
}

// ─── 工具 ───────────────────────────────────────────────
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown, ctx: string): string {
  if (typeof v !== 'string') throw new Error(`${ctx} 非字符串`);
  return v;
}

function asNumber(v: unknown, ctx: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${ctx} 非有限数字`);
  }
  return v;
}

function asBoolean(v: unknown, ctx: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${ctx} 非布尔`);
  return v;
}

function asStringArray(v: unknown, ctx: string): string[] {
  if (!Array.isArray(v)) throw new Error(`${ctx} 非数组`);
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (typeof item !== 'string') throw new Error(`${ctx}[${i}] 非字符串`);
    out.push(item);
  }
  return out;
}

function chapterNum(code: string): number {
  const m = code.match(/^(\d+)-/);
  return m ? parseInt(m[1], 10) : 9999;
}

function round4(x: number): number {
  return Number(x.toFixed(4));
}

function fmt4(x: number): string {
  return x.toFixed(4);
}

function fmtDelta(delta: number): string {
  // 显示精度内归零:V1 现算(未 round)与 V2 已 round4 存值相减会产生 < 0.0001 的浮点噪声,
  // 直接 toFixed(4) 会显示 "-0.0000",对读者不友好。先 round4 后再判号。
  const rounded = round4(delta);
  const sign = rounded >= 0 ? '+' : '';
  return `${sign}${rounded.toFixed(4)}`;
}

// ─── 解析 + 类型守卫 ───────────────────────────────────
function parseRetrieved(v: unknown, ctx: string): RetrievedItem {
  if (!isRecord(v)) throw new Error(`${ctx} 非对象`);
  return {
    rank: asNumber(v.rank, `${ctx}.rank`),
    chunk_id: asString(v.chunk_id, `${ctx}.chunk_id`),
    chunk_short_id: asString(v.chunk_short_id, `${ctx}.chunk_short_id`),
    chapter_tags: asStringArray(v.chapter_tags, `${ctx}.chapter_tags`),
    similarity: asNumber(v.similarity, `${ctx}.similarity`),
    hit: asBoolean(v.hit, `${ctx}.hit`),
  };
}

function parseRetrievedR(v: unknown, ctx: string): RetrievedItemR {
  const base = parseRetrieved(v, ctx);
  if (!isRecord(v)) throw new Error(`${ctx} 非对象`); // 已在 parseRetrieved 里抛过,这里给 TS 缩窄
  return {
    ...base,
    rerank_score: asNumber(v.rerank_score, `${ctx}.rerank_score`),
  };
}

function parseQuestionType(v: unknown, ctx: string): QuestionType {
  if (v !== 'fact' && v !== 'colloquial') {
    throw new Error(`${ctx} 非 fact/colloquial`);
  }
  return v;
}

function parsePerQuestionV1(v: unknown, idx: number): PerQuestionV1 {
  const ctx = `v1.per_question[${idx}]`;
  if (!isRecord(v)) throw new Error(`${ctx} 非对象`);
  if (!Array.isArray(v.retrieved)) throw new Error(`${ctx}.retrieved 非数组`);
  const retrieved = v.retrieved.map((r, i) =>
    parseRetrieved(r, `${ctx}.retrieved[${i}]`),
  );
  return {
    qid: asString(v.qid, `${ctx}.qid`),
    question: asString(v.question, `${ctx}.question`),
    question_type: parseQuestionType(v.question_type, `${ctx}.question_type`),
    ground_truth_chapter: asString(
      v.ground_truth_chapter,
      `${ctx}.ground_truth_chapter`,
    ),
    secondary_chapters: asStringArray(
      v.secondary_chapters,
      `${ctx}.secondary_chapters`,
    ),
    retrieved,
    hit_at_5: asBoolean(v.hit_at_5, `${ctx}.hit_at_5`),
    mrr: asNumber(v.mrr, `${ctx}.mrr`),
  };
}

function parsePerQuestionV2(v: unknown, idx: number): PerQuestionV2 {
  const ctx = `v2.per_question[${idx}]`;
  if (!isRecord(v)) throw new Error(`${ctx} 非对象`);
  if (!Array.isArray(v.retrieved)) throw new Error(`${ctx}.retrieved 非数组`);
  const retrieved = v.retrieved.map((r, i) =>
    parseRetrieved(r, `${ctx}.retrieved[${i}]`),
  );
  return {
    qid: asString(v.qid, `${ctx}.qid`),
    question: asString(v.question, `${ctx}.question`),
    question_type: parseQuestionType(v.question_type, `${ctx}.question_type`),
    ground_truth_chapter: asString(
      v.ground_truth_chapter,
      `${ctx}.ground_truth_chapter`,
    ),
    secondary_chapters: asStringArray(
      v.secondary_chapters,
      `${ctx}.secondary_chapters`,
    ),
    retrieved,
    hit_at_1: asBoolean(v.hit_at_1, `${ctx}.hit_at_1`),
    hit_at_5: asBoolean(v.hit_at_5, `${ctx}.hit_at_5`),
    mrr: asNumber(v.mrr, `${ctx}.mrr`),
  };
}

function parsePerQuestionV2R(v: unknown, idx: number): PerQuestionV2R {
  const ctx = `v2reranker.per_question[${idx}]`;
  if (!isRecord(v)) throw new Error(`${ctx} 非对象`);
  if (!Array.isArray(v.retrieved)) throw new Error(`${ctx}.retrieved 非数组`);
  const retrieved = v.retrieved.map((r, i) =>
    parseRetrievedR(r, `${ctx}.retrieved[${i}]`),
  );
  return {
    qid: asString(v.qid, `${ctx}.qid`),
    question: asString(v.question, `${ctx}.question`),
    question_type: parseQuestionType(v.question_type, `${ctx}.question_type`),
    ground_truth_chapter: asString(
      v.ground_truth_chapter,
      `${ctx}.ground_truth_chapter`,
    ),
    secondary_chapters: asStringArray(
      v.secondary_chapters,
      `${ctx}.secondary_chapters`,
    ),
    retrieved,
    hit_at_1: asBoolean(v.hit_at_1, `${ctx}.hit_at_1`),
    hit_at_5: asBoolean(v.hit_at_5, `${ctx}.hit_at_5`),
    mrr: asNumber(v.mrr, `${ctx}.mrr`),
  };
}

function parseBucketV1(v: unknown, ctx: string): AggregateBucketV1 {
  if (!isRecord(v)) throw new Error(`${ctx} 非对象`);
  return {
    n: asNumber(v.n, `${ctx}.n`),
    recall_at_5: asNumber(v.recall_at_5, `${ctx}.recall_at_5`),
    mrr: asNumber(v.mrr, `${ctx}.mrr`),
  };
}

function parseBucketV2(v: unknown, ctx: string): AggregateBucketV2 {
  if (!isRecord(v)) throw new Error(`${ctx} 非对象`);
  return {
    n: asNumber(v.n, `${ctx}.n`),
    recall_at_1: asNumber(v.recall_at_1, `${ctx}.recall_at_1`),
    recall_at_5: asNumber(v.recall_at_5, `${ctx}.recall_at_5`),
    mrr: asNumber(v.mrr, `${ctx}.mrr`),
  };
}

function parseV1(raw: string): BaselineJsonV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`V1 JSON 解析失败:${msg}`);
  }
  if (!isRecord(parsed)) throw new Error('V1 顶层非对象');
  if (!isRecord(parsed.model_config)) throw new Error('V1.model_config 非对象');
  if (!isRecord(parsed.summary)) throw new Error('V1.summary 非对象');
  if (!Array.isArray(parsed.per_question)) {
    throw new Error('V1.per_question 非数组');
  }
  const summary = parsed.summary;
  if (!isRecord(summary.by_question_type)) {
    throw new Error('V1.summary.by_question_type 非对象');
  }
  if (!isRecord(summary.by_chapter)) {
    throw new Error('V1.summary.by_chapter 非对象');
  }
  const byQt = summary.by_question_type;
  const byChapter: Record<string, AggregateBucketV1> = {};
  for (const [k, v] of Object.entries(summary.by_chapter)) {
    byChapter[k] = parseBucketV1(v, `V1.summary.by_chapter.${k}`);
  }
  return {
    tenant_id: asString(parsed.tenant_id, 'V1.tenant_id'),
    model_config: {
      embedding: asString(parsed.model_config.embedding, 'V1.model_config.embedding'),
      top_k: asNumber(parsed.model_config.top_k, 'V1.model_config.top_k'),
    },
    run_at: asString(parsed.run_at, 'V1.run_at'),
    summary: {
      total_questions: asNumber(summary.total_questions, 'V1.summary.total_questions'),
      recall_at_5_overall: asNumber(
        summary.recall_at_5_overall,
        'V1.summary.recall_at_5_overall',
      ),
      mrr_overall: asNumber(summary.mrr_overall, 'V1.summary.mrr_overall'),
      by_question_type: {
        fact: parseBucketV1(byQt.fact, 'V1.summary.by_question_type.fact'),
        colloquial: parseBucketV1(
          byQt.colloquial,
          'V1.summary.by_question_type.colloquial',
        ),
      },
      by_chapter: byChapter,
    },
    per_question: parsed.per_question.map((q, i) => parsePerQuestionV1(q, i)),
  };
}

function parseV2(raw: string): V2Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`V2 JSON 解析失败:${msg}`);
  }
  if (!isRecord(parsed)) throw new Error('V2 顶层非对象');
  if (parsed.version !== 'v2') {
    throw new Error(`V2.version 非 'v2'(实际:${String(parsed.version)})`);
  }
  if (!isRecord(parsed.model_config)) throw new Error('V2.model_config 非对象');
  if (!isRecord(parsed.summary)) throw new Error('V2.summary 非对象');
  if (!Array.isArray(parsed.per_question)) {
    throw new Error('V2.per_question 非数组');
  }
  const summary = parsed.summary;
  if (!isRecord(summary.by_question_type)) {
    throw new Error('V2.summary.by_question_type 非对象');
  }
  if (!isRecord(summary.by_chapter)) {
    throw new Error('V2.summary.by_chapter 非对象');
  }
  const byQt = summary.by_question_type;
  const byChapter: Record<string, AggregateBucketV2> = {};
  for (const [k, v] of Object.entries(summary.by_chapter)) {
    byChapter[k] = parseBucketV2(v, `V2.summary.by_chapter.${k}`);
  }
  return {
    version: 'v2',
    tenant_id: asString(parsed.tenant_id, 'V2.tenant_id'),
    model_config: {
      embedding: asString(parsed.model_config.embedding, 'V2.model_config.embedding'),
      top_k: asNumber(parsed.model_config.top_k, 'V2.model_config.top_k'),
    },
    run_at: asString(parsed.run_at, 'V2.run_at'),
    comparison_note: asString(parsed.comparison_note, 'V2.comparison_note'),
    summary: {
      total_questions: asNumber(summary.total_questions, 'V2.summary.total_questions'),
      recall_at_1_overall: asNumber(
        summary.recall_at_1_overall,
        'V2.summary.recall_at_1_overall',
      ),
      recall_at_5_overall: asNumber(
        summary.recall_at_5_overall,
        'V2.summary.recall_at_5_overall',
      ),
      mrr_overall: asNumber(summary.mrr_overall, 'V2.summary.mrr_overall'),
      by_question_type: {
        fact: parseBucketV2(byQt.fact, 'V2.summary.by_question_type.fact'),
        colloquial: parseBucketV2(
          byQt.colloquial,
          'V2.summary.by_question_type.colloquial',
        ),
      },
      by_chapter: byChapter,
    },
    per_question: parsed.per_question.map((q, i) => parsePerQuestionV2(q, i)),
  };
}

function parseV2R(raw: string): V2RerankerJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`V2+reranker JSON 解析失败:${msg}`);
  }
  if (!isRecord(parsed)) throw new Error('V2+reranker 顶层非对象');
  if (parsed.version !== 'v2-reranker') {
    throw new Error(
      `V2+reranker.version 非 'v2-reranker'(实际:${String(parsed.version)})`,
    );
  }
  if (!isRecord(parsed.model_config)) {
    throw new Error('V2+reranker.model_config 非对象');
  }
  if (!isRecord(parsed.summary)) throw new Error('V2+reranker.summary 非对象');
  if (!Array.isArray(parsed.per_question)) {
    throw new Error('V2+reranker.per_question 非数组');
  }
  const summary = parsed.summary;
  if (!isRecord(summary.by_question_type)) {
    throw new Error('V2+reranker.summary.by_question_type 非对象');
  }
  if (!isRecord(summary.by_chapter)) {
    throw new Error('V2+reranker.summary.by_chapter 非对象');
  }
  const byQt = summary.by_question_type;
  const byChapter: Record<string, AggregateBucketV2> = {};
  for (const [k, v] of Object.entries(summary.by_chapter)) {
    byChapter[k] = parseBucketV2(v, `V2+reranker.summary.by_chapter.${k}`);
  }
  return {
    version: 'v2-reranker',
    tenant_id: asString(parsed.tenant_id, 'V2+reranker.tenant_id'),
    model_config: {
      embedding: asString(
        parsed.model_config.embedding,
        'V2+reranker.model_config.embedding',
      ),
      recall_k: asNumber(parsed.model_config.recall_k, 'V2+reranker.model_config.recall_k'),
      final_k: asNumber(parsed.model_config.final_k, 'V2+reranker.model_config.final_k'),
      reranker_model: asString(
        parsed.model_config.reranker_model,
        'V2+reranker.model_config.reranker_model',
      ),
    },
    run_at: asString(parsed.run_at, 'V2+reranker.run_at'),
    comparison_note: asString(parsed.comparison_note, 'V2+reranker.comparison_note'),
    summary: {
      total_questions: asNumber(
        summary.total_questions,
        'V2+reranker.summary.total_questions',
      ),
      recall_at_1_overall: asNumber(
        summary.recall_at_1_overall,
        'V2+reranker.summary.recall_at_1_overall',
      ),
      recall_at_5_overall: asNumber(
        summary.recall_at_5_overall,
        'V2+reranker.summary.recall_at_5_overall',
      ),
      mrr_overall: asNumber(summary.mrr_overall, 'V2+reranker.summary.mrr_overall'),
      by_question_type: {
        fact: parseBucketV2(byQt.fact, 'V2+reranker.summary.by_question_type.fact'),
        colloquial: parseBucketV2(
          byQt.colloquial,
          'V2+reranker.summary.by_question_type.colloquial',
        ),
      },
      by_chapter: byChapter,
    },
    per_question: parsed.per_question.map((q, i) => parsePerQuestionV2R(q, i)),
  };
}

// ─── V1 Recall@1 现算(主题 18.3)─────────────────────
// 口径:retrieved[0]?.hit ?? false,与 V2 / V2+reranker hit_at_1 字节级一致
function computeV1Recall1(qs: PerQuestionV1[]): number {
  if (qs.length === 0) return 0;
  const hit1 = qs.filter((q) => q.retrieved[0]?.hit ?? false).length;
  return hit1 / qs.length;
}

// ─── 主流程 ────────────────────────────────────────────
interface PerQuestionDiff {
  qid: string;
  gt: string;
  v1Mrr: number;
  v2Mrr: number;
  v2rMrr: number;
  v1Hit1: boolean;
  v2Hit1: boolean;
  v2rHit1: boolean;
  v1Top1Short: string;
  v2Top1Short: string;
  v2rTop1Short: string;
  v2rTop1Score: number; // 覆盖度自证
  v2VsV1Changed: boolean; // top1 / hit1 / mrr 任一变化
  v2rVsV2Changed: boolean;
}

interface OverallStats {
  v2VsV1Top1: number;
  v2VsV1Hit1: number;
  v2VsV1Mrr: number;
  v2rVsV2Top1: number;
  v2rVsV2Hit1: number;
  v2rVsV2Mrr: number;
}

function main(): void {
  console.log('═'.repeat(86));
  console.log('V1 vs V2 vs V2+Reranker 三方检索质量对比 — 口径 A(纯检索器,不跑 Agent)');
  console.log('═'.repeat(86));

  // 1. 文件存在兜底
  for (const p of [V1_PATH, V2_PATH, V2R_PATH]) {
    if (!fs.existsSync(p)) {
      console.error(`[失败] 找不到 ${p}`);
      process.exit(1);
    }
  }

  // 2. 解析
  const v1 = parseV1(fs.readFileSync(V1_PATH, 'utf8'));
  const v2 = parseV2(fs.readFileSync(V2_PATH, 'utf8'));
  const v2r = parseV2R(fs.readFileSync(V2R_PATH, 'utf8'));

  // 3. qid 三方对齐校验
  const v1Qids = v1.per_question.map((q) => q.qid).sort();
  const v2Qids = v2.per_question.map((q) => q.qid).sort();
  const v2rQids = v2r.per_question.map((q) => q.qid).sort();
  if (v1Qids.length !== v2Qids.length || v1Qids.length !== v2rQids.length) {
    console.error(
      `[失败] qid 数量不一致 V1=${v1Qids.length} V2=${v2Qids.length} V2+R=${v2rQids.length}`,
    );
    process.exit(1);
  }
  for (let i = 0; i < v1Qids.length; i++) {
    if (v1Qids[i] !== v2Qids[i] || v1Qids[i] !== v2rQids[i]) {
      console.error(
        `[失败] qid 不一致[${i}]:V1=${v1Qids[i]} V2=${v2Qids[i]} V2+R=${v2rQids[i]}`,
      );
      process.exit(1);
    }
  }

  console.log(`V1 baseline:    run_at=${v1.run_at}  ${v1.per_question.length} 题`);
  console.log(`V2:             run_at=${v2.run_at}  ${v2.per_question.length} 题`);
  console.log(`V2+Reranker:    run_at=${v2r.run_at}  ${v2r.per_question.length} 题`);
  console.log(`qid 三方对齐:    ✓ ${v1Qids.length}/${v2Qids.length}/${v2rQids.length} 一致\n`);

  // 4. 现算 V1 Recall@1(overall + by_qt + by_chapter)
  const v1Recall1Overall = computeV1Recall1(v1.per_question);
  const v1FactQs = v1.per_question.filter((q) => q.question_type === 'fact');
  const v1ColloqQs = v1.per_question.filter((q) => q.question_type === 'colloquial');
  const v1Recall1Fact = computeV1Recall1(v1FactQs);
  const v1Recall1Colloq = computeV1Recall1(v1ColloqQs);

  const v1ChapterMap = new Map<string, PerQuestionV1[]>();
  for (const q of v1.per_question) {
    const list = v1ChapterMap.get(q.ground_truth_chapter) ?? [];
    list.push(q);
    v1ChapterMap.set(q.ground_truth_chapter, list);
  }
  const v1Recall1ByChapter = new Map<string, number>();
  for (const [ch, list] of v1ChapterMap) {
    v1Recall1ByChapter.set(ch, computeV1Recall1(list));
  }

  // 5. 章节键升序 — V1 章节集合为基准,V2 / V2+reranker 应一致
  const chapterKeys = [...v1ChapterMap.keys()].sort(
    (a, b) => chapterNum(a) - chapterNum(b),
  );
  for (const ch of chapterKeys) {
    if (!v2.summary.by_chapter[ch]) {
      console.error(`[失败] V2.by_chapter 缺章节 ${ch}`);
      process.exit(1);
    }
    if (!v2r.summary.by_chapter[ch]) {
      console.error(`[失败] V2+R.by_chapter 缺章节 ${ch}`);
      process.exit(1);
    }
  }

  // 6. 主指标控制台输出(三栏 + 两组 Δ)
  console.log('— 主指标(EXPERIENCE 主题 13.4 拍板:Recall@1 + MRR 主指标,Recall@5 仅参考)');
  console.log(
    `${''.padEnd(14)}${'V1'.padStart(10)}${'V2'.padStart(10)}${'V2+R'.padStart(10)}${'Δ(V2-V1)'.padStart(12)}${'Δ(V2+R-V2)'.padStart(14)}`,
  );
  const r1Row = [
    fmt4(round4(v1Recall1Overall)),
    fmt4(v2.summary.recall_at_1_overall),
    fmt4(v2r.summary.recall_at_1_overall),
    fmtDelta(v2.summary.recall_at_1_overall - v1Recall1Overall),
    fmtDelta(v2r.summary.recall_at_1_overall - v2.summary.recall_at_1_overall),
  ];
  const r5Row = [
    fmt4(v1.summary.recall_at_5_overall),
    fmt4(v2.summary.recall_at_5_overall),
    fmt4(v2r.summary.recall_at_5_overall),
    fmtDelta(v2.summary.recall_at_5_overall - v1.summary.recall_at_5_overall),
    fmtDelta(v2r.summary.recall_at_5_overall - v2.summary.recall_at_5_overall),
  ];
  const mrrRow = [
    fmt4(v1.summary.mrr_overall),
    fmt4(v2.summary.mrr_overall),
    fmt4(v2r.summary.mrr_overall),
    fmtDelta(v2.summary.mrr_overall - v1.summary.mrr_overall),
    fmtDelta(v2r.summary.mrr_overall - v2.summary.mrr_overall),
  ];
  console.log(
    `${'Recall@1:'.padEnd(14)}${r1Row[0].padStart(10)}${r1Row[1].padStart(10)}${r1Row[2].padStart(10)}${r1Row[3].padStart(12)}${r1Row[4].padStart(14)}`,
  );
  console.log(
    `${'Recall@5:'.padEnd(14)}${r5Row[0].padStart(10)}${r5Row[1].padStart(10)}${r5Row[2].padStart(10)}${r5Row[3].padStart(12)}${r5Row[4].padStart(14)}`,
  );
  console.log(
    `${'MRR:'.padEnd(14)}${mrrRow[0].padStart(10)}${mrrRow[1].padStart(10)}${mrrRow[2].padStart(10)}${mrrRow[3].padStart(12)}${mrrRow[4].padStart(14)}\n`,
  );

  // 7. 按 question_type
  console.log('— 按 question_type');
  console.log(
    `${'type'.padEnd(13)}${'n'.padStart(4)}${'V1 R@1'.padStart(10)}${'V2 R@1'.padStart(10)}${'V2+R R@1'.padStart(11)}${'V1 MRR'.padStart(10)}${'V2 MRR'.padStart(10)}${'V2+R MRR'.padStart(11)}`,
  );
  const qtRows: Array<[
    string,
    number,
    number,
    AggregateBucketV1,
    AggregateBucketV2,
    AggregateBucketV2,
  ]> = [
    [
      'fact',
      v1FactQs.length,
      v1Recall1Fact,
      v1.summary.by_question_type.fact,
      v2.summary.by_question_type.fact,
      v2r.summary.by_question_type.fact,
    ],
    [
      'colloquial',
      v1ColloqQs.length,
      v1Recall1Colloq,
      v1.summary.by_question_type.colloquial,
      v2.summary.by_question_type.colloquial,
      v2r.summary.by_question_type.colloquial,
    ],
  ];
  for (const [name, n, v1R1, v1B, v2B, v2rB] of qtRows) {
    console.log(
      `${name.padEnd(13)}${String(n).padStart(4)}${fmt4(round4(v1R1)).padStart(10)}${fmt4(v2B.recall_at_1).padStart(10)}${fmt4(v2rB.recall_at_1).padStart(11)}${fmt4(v1B.mrr).padStart(10)}${fmt4(v2B.mrr).padStart(10)}${fmt4(v2rB.mrr).padStart(11)}`,
    );
  }
  console.log('');

  // 8. 按 ground_truth_chapter
  console.log('— 按 ground_truth_chapter(章节升序)');
  console.log(
    `${'chapter'.padEnd(18)}${'n'.padStart(4)}${'V1 R@1'.padStart(10)}${'V2 R@1'.padStart(10)}${'V2+R R@1'.padStart(11)}${'V1 MRR'.padStart(10)}${'V2 MRR'.padStart(10)}${'V2+R MRR'.padStart(11)}`,
  );
  for (const ch of chapterKeys) {
    const v1R1 = v1Recall1ByChapter.get(ch) ?? 0;
    const v1B = v1.summary.by_chapter[ch];
    const v2B = v2.summary.by_chapter[ch];
    const v2rB = v2r.summary.by_chapter[ch];
    console.log(
      `${ch.padEnd(18)}${String(v1B.n).padStart(4)}${fmt4(round4(v1R1)).padStart(10)}${fmt4(v2B.recall_at_1).padStart(10)}${fmt4(v2rB.recall_at_1).padStart(11)}${fmt4(v1B.mrr).padStart(10)}${fmt4(v2B.mrr).padStart(10)}${fmt4(v2rB.mrr).padStart(11)}`,
    );
  }
  console.log('');

  // 9. 逐题 diff(qid 升序)
  const sortedQids = [...v1Qids];
  const v1Map = new Map(v1.per_question.map((q) => [q.qid, q]));
  const v2Map = new Map(v2.per_question.map((q) => [q.qid, q]));
  const v2rMap = new Map(v2r.per_question.map((q) => [q.qid, q]));
  const perQuestionDiffs: PerQuestionDiff[] = [];
  const stats: OverallStats = {
    v2VsV1Top1: 0,
    v2VsV1Hit1: 0,
    v2VsV1Mrr: 0,
    v2rVsV2Top1: 0,
    v2rVsV2Hit1: 0,
    v2rVsV2Mrr: 0,
  };

  for (const qid of sortedQids) {
    const v1q = v1Map.get(qid);
    const v2q = v2Map.get(qid);
    const v2rq = v2rMap.get(qid);
    if (!v1q || !v2q || !v2rq) {
      console.error(`[失败] 内部错误:qid=${qid} 三方 map 之一取不到值`);
      process.exit(1);
    }
    const v1Hit1 = v1q.retrieved[0]?.hit ?? false;
    const v2Hit1 = v2q.hit_at_1;
    const v2rHit1 = v2rq.hit_at_1;
    const v1Top1Id = v1q.retrieved[0]?.chunk_id ?? '';
    const v2Top1Id = v2q.retrieved[0]?.chunk_id ?? '';
    const v2rTop1Id = v2rq.retrieved[0]?.chunk_id ?? '';
    const v1Top1Short = v1q.retrieved[0]?.chunk_short_id ?? '(空)';
    const v2Top1Short = v2q.retrieved[0]?.chunk_short_id ?? '(空)';
    const v2rTop1Short = v2rq.retrieved[0]?.chunk_short_id ?? '(空)';
    const v2rTop1Score = v2rq.retrieved[0]?.rerank_score ?? 0;

    const v2v1TopCh = v1Top1Id !== v2Top1Id;
    const v2v1H1Ch = v1Hit1 !== v2Hit1;
    const v2v1MCh = Math.abs(v1q.mrr - v2q.mrr) > 1e-9;
    if (v2v1TopCh) stats.v2VsV1Top1++;
    if (v2v1H1Ch) stats.v2VsV1Hit1++;
    if (v2v1MCh) stats.v2VsV1Mrr++;

    const v2rv2TopCh = v2Top1Id !== v2rTop1Id;
    const v2rv2H1Ch = v2Hit1 !== v2rHit1;
    const v2rv2MCh = Math.abs(v2q.mrr - v2rq.mrr) > 1e-9;
    if (v2rv2TopCh) stats.v2rVsV2Top1++;
    if (v2rv2H1Ch) stats.v2rVsV2Hit1++;
    if (v2rv2MCh) stats.v2rVsV2Mrr++;

    perQuestionDiffs.push({
      qid,
      gt: v1q.ground_truth_chapter,
      v1Mrr: v1q.mrr,
      v2Mrr: v2q.mrr,
      v2rMrr: v2rq.mrr,
      v1Hit1,
      v2Hit1,
      v2rHit1,
      v1Top1Short,
      v2Top1Short,
      v2rTop1Short,
      v2rTop1Score,
      v2VsV1Changed: v2v1TopCh || v2v1H1Ch || v2v1MCh,
      v2rVsV2Changed: v2rv2TopCh || v2rv2H1Ch || v2rv2MCh,
    });
  }

  const total = sortedQids.length;
  console.log('— 逐题 diff 汇总');
  console.log(`V2 vs V1     Top-1 chunk 变化:${stats.v2VsV1Top1}/${total}  hit@1 变化:${stats.v2VsV1Hit1}/${total}  mrr 变化:${stats.v2VsV1Mrr}/${total}`);
  console.log(`V2+R vs V2   Top-1 chunk 变化:${stats.v2rVsV2Top1}/${total}  hit@1 变化:${stats.v2rVsV2Hit1}/${total}  mrr 变化:${stats.v2rVsV2Mrr}/${total}\n`);

  // 9.5 Rerank 覆盖度自证
  const top1Scores = perQuestionDiffs.map((d) => d.v2rTop1Score);
  const sorted = [...top1Scores].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const minScore = sorted[0];
  const maxScore = sorted[sorted.length - 1];
  const zeroCount = top1Scores.filter((s) => s === 0).length;
  console.log('— Rerank 覆盖度自证(V2+R 全 44 题 top-1 rerank_score 分布)');
  console.log(
    `  样本=${top1Scores.length}/${total}  min=${round4(minScore).toFixed(4)}  median=${round4(median).toFixed(4)}  max=${round4(maxScore).toFixed(4)}  零值=${zeroCount}`,
  );
  if (zeroCount > 0) {
    console.warn(
      `  ⚠️ 有 ${zeroCount} 题 top1 rerank_score=0,可能该题 rerank 未生效,请核查`,
    );
  } else {
    console.log('  ✓ 无 0 值,rerank 在全 44 题样本均生效');
  }
  console.log('');

  // 10. 写 markdown 报告
  const md = renderMarkdown({
    v1,
    v2,
    v2r,
    v1Recall1Overall,
    v1Recall1Fact,
    v1Recall1Colloq,
    v1Recall1ByChapter,
    v1FactN: v1FactQs.length,
    v1ColloqN: v1ColloqQs.length,
    chapterKeys,
    perQuestionDiffs,
    stats,
    rerankScoreMin: minScore,
    rerankScoreMedian: median,
    rerankScoreMax: maxScore,
    rerankZeroCount: zeroCount,
  });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, md, 'utf8'); // Node 默认 UTF-8 无 BOM

  // 11. 结论
  console.log('— 结论(口径 A 诚实表述)');
  const v2VsV1Same =
    stats.v2VsV1Top1 === 0 && stats.v2VsV1Hit1 === 0 && stats.v2VsV1Mrr === 0;
  const v2rVsV2Same =
    stats.v2rVsV2Top1 === 0 && stats.v2rVsV2Hit1 === 0 && stats.v2rVsV2Mrr === 0;
  if (v2VsV1Same) {
    console.log('  V1 = V2(Agent 化未劣化检索;Step 25.2b 已证)');
  } else {
    console.log(
      `  ⚠️ V2 与 V1 有 ${stats.v2VsV1Top1 + stats.v2VsV1Hit1 + stats.v2VsV1Mrr} 项差异,请核查 embedding 稳定性`,
    );
  }
  if (v2rVsV2Same) {
    console.log('  V2 = V2+Reranker  Top-1 / hit@1 / mrr 全无变化');
    console.log('  → Reranker 未改变 top-5 内的排名(或仅改第 5 位,对 hit@1/mrr 不可见)');
    console.log('  → 11 chunk 全集样本上限触顶,无法量化提升;主题 18.2 守住,不造假数字');
  } else {
    console.log(
      `  Reranker 改变 ${stats.v2rVsV2Top1} 题 top-1 / ${stats.v2rVsV2Hit1} 题 hit@1 / ${stats.v2rVsV2Mrr} 题 mrr`,
    );
    const dR1 = v2r.summary.recall_at_1_overall - v2.summary.recall_at_1_overall;
    const dMrr = v2r.summary.mrr_overall - v2.summary.mrr_overall;
    console.log(
      `  ΔRecall@1 = ${fmtDelta(dR1)}   ΔMRR = ${fmtDelta(dMrr)}(整体口径)`,
    );
  }
  console.log(`\n✅ 写入 ${REPORT_PATH}`);
  console.log('═'.repeat(86));
}

// ─── Markdown 渲染 ──────────────────────────────────────
interface RenderInput {
  v1: BaselineJsonV1;
  v2: V2Json;
  v2r: V2RerankerJson;
  v1Recall1Overall: number;
  v1Recall1Fact: number;
  v1Recall1Colloq: number;
  v1Recall1ByChapter: Map<string, number>;
  v1FactN: number;
  v1ColloqN: number;
  chapterKeys: string[];
  perQuestionDiffs: PerQuestionDiff[];
  stats: OverallStats;
  rerankScoreMin: number;
  rerankScoreMedian: number;
  rerankScoreMax: number;
  rerankZeroCount: number;
}

function renderMarkdown(d: RenderInput): string {
  const { v1, v2, v2r } = d;
  const dR1_v2v1 = v2.summary.recall_at_1_overall - d.v1Recall1Overall;
  const dR5_v2v1 = v2.summary.recall_at_5_overall - v1.summary.recall_at_5_overall;
  const dMrr_v2v1 = v2.summary.mrr_overall - v1.summary.mrr_overall;
  const dR1_v2rv2 = v2r.summary.recall_at_1_overall - v2.summary.recall_at_1_overall;
  const dR5_v2rv2 = v2r.summary.recall_at_5_overall - v2.summary.recall_at_5_overall;
  const dMrr_v2rv2 = v2r.summary.mrr_overall - v2.summary.mrr_overall;
  const total = v1.per_question.length;

  const lines: string[] = [];
  lines.push('# V1 vs V2 vs V2+Reranker 检索质量对比报告');
  lines.push('');
  lines.push('> 评估口径 A:直接比较检索器输出,不跑 Agent 决策层、不跑 LLM');
  lines.push('> 由 `scripts/eval/compare-three-way.ts` 自动生成(Step 26.4)');
  lines.push(`> _生成于 ${new Date().toISOString()}_`);
  lines.push('');

  // 1. 评估元信息
  lines.push('## 1. 评估元信息');
  lines.push('');
  lines.push('| 项 | V1 baseline | V2 | V2+Reranker |');
  lines.push('|---|---|---|---|');
  lines.push(`| tenant_id | \`${v1.tenant_id}\` | \`${v2.tenant_id}\` | \`${v2r.tenant_id}\` |`);
  lines.push(`| embedding | ${v1.model_config.embedding} | ${v2.model_config.embedding} | ${v2r.model_config.embedding} |`);
  lines.push(`| top_k / recall→final | ${v1.model_config.top_k} | ${v2.model_config.top_k} | ${v2r.model_config.recall_k} → ${v2r.model_config.final_k} |`);
  lines.push(`| reranker_model | — | — | ${v2r.model_config.reranker_model} |`);
  lines.push(`| run_at | ${v1.run_at} | ${v2.run_at} | ${v2r.run_at} |`);
  lines.push(`| 总题数 | ${v1.summary.total_questions} | ${v2.summary.total_questions} | ${v2r.summary.total_questions} |`);
  lines.push('');

  // 2. 主指标
  lines.push('## 2. 主指标对比');
  lines.push('');
  lines.push('> 主指标依据:`EXPERIENCE.md` 主题 13.4(11 chunk 全集下 Recall@5 失区分度,主指标 Recall@1 + MRR);');
  lines.push('> V1 baseline 数字依据:`HANDOFF.md` 第六节 Step 22(`v1-baseline` tag)。');
  lines.push('');
  lines.push('| 指标 | V1 | V2 | V2+R | Δ(V2−V1) | Δ(V2+R−V2) |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  lines.push(`| Recall@1 | ${fmt4(round4(d.v1Recall1Overall))} | ${fmt4(v2.summary.recall_at_1_overall)} | ${fmt4(v2r.summary.recall_at_1_overall)} | ${fmtDelta(dR1_v2v1)} | ${fmtDelta(dR1_v2rv2)} |`);
  lines.push(`| Recall@5 | ${fmt4(v1.summary.recall_at_5_overall)} | ${fmt4(v2.summary.recall_at_5_overall)} | ${fmt4(v2r.summary.recall_at_5_overall)} | ${fmtDelta(dR5_v2v1)} | ${fmtDelta(dR5_v2rv2)} |`);
  lines.push(`| MRR | ${fmt4(v1.summary.mrr_overall)} | ${fmt4(v2.summary.mrr_overall)} | ${fmt4(v2r.summary.mrr_overall)} | ${fmtDelta(dMrr_v2v1)} | ${fmtDelta(dMrr_v2rv2)} |`);
  lines.push('');
  lines.push('> ⚠️ V1 baseline JSON 不含 `recall_at_1` 字段,本脚本从 `per_question[i].retrieved[0].hit` 现算,与 V2 / V2+R 的 `hit_at_1` 字段(同样 = `retrieved[0]?.hit ?? false`)字节级一致。');
  lines.push('');

  // 3. 按 question_type
  lines.push('## 3. 按 question_type 对比');
  lines.push('');
  lines.push('| type | n | V1 R@1 | V2 R@1 | V2+R R@1 | V1 R@5 | V2 R@5 | V2+R R@5 | V1 MRR | V2 MRR | V2+R MRR |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  const qtRows: Array<[
    string,
    number,
    number,
    AggregateBucketV1,
    AggregateBucketV2,
    AggregateBucketV2,
  ]> = [
    [
      'fact',
      d.v1FactN,
      d.v1Recall1Fact,
      v1.summary.by_question_type.fact,
      v2.summary.by_question_type.fact,
      v2r.summary.by_question_type.fact,
    ],
    [
      'colloquial',
      d.v1ColloqN,
      d.v1Recall1Colloq,
      v1.summary.by_question_type.colloquial,
      v2.summary.by_question_type.colloquial,
      v2r.summary.by_question_type.colloquial,
    ],
  ];
  for (const [name, n, v1R1, v1B, v2B, v2rB] of qtRows) {
    lines.push(
      `| ${name} | ${n} | ${fmt4(round4(v1R1))} | ${fmt4(v2B.recall_at_1)} | ${fmt4(v2rB.recall_at_1)} | ${fmt4(v1B.recall_at_5)} | ${fmt4(v2B.recall_at_5)} | ${fmt4(v2rB.recall_at_5)} | ${fmt4(v1B.mrr)} | ${fmt4(v2B.mrr)} | ${fmt4(v2rB.mrr)} |`,
    );
  }
  lines.push('');

  // 4. 按 ground_truth_chapter
  lines.push('## 4. 按 ground_truth_chapter 对比');
  lines.push('');
  lines.push('| chapter | n | V1 R@1 | V2 R@1 | V2+R R@1 | V1 R@5 | V2 R@5 | V2+R R@5 | V1 MRR | V2 MRR | V2+R MRR |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const ch of d.chapterKeys) {
    const v1B = v1.summary.by_chapter[ch];
    const v2B = v2.summary.by_chapter[ch];
    const v2rB = v2r.summary.by_chapter[ch];
    const v1R1 = d.v1Recall1ByChapter.get(ch) ?? 0;
    lines.push(
      `| ${ch} | ${v1B.n} | ${fmt4(round4(v1R1))} | ${fmt4(v2B.recall_at_1)} | ${fmt4(v2rB.recall_at_1)} | ${fmt4(v1B.recall_at_5)} | ${fmt4(v2B.recall_at_5)} | ${fmt4(v2rB.recall_at_5)} | ${fmt4(v1B.mrr)} | ${fmt4(v2B.mrr)} | ${fmt4(v2rB.mrr)} |`,
    );
  }
  lines.push('');

  // 5. 逐题 diff(全 44 题)
  lines.push('## 5. 逐题 diff(全题)');
  lines.push('');
  lines.push(`V2 vs V1   Top-1 chunk 变化:**${d.stats.v2VsV1Top1} / ${total}**;hit@1 变化:**${d.stats.v2VsV1Hit1} / ${total}**;mrr 变化:**${d.stats.v2VsV1Mrr} / ${total}**`);
  lines.push('');
  lines.push(`V2+R vs V2 Top-1 chunk 变化:**${d.stats.v2rVsV2Top1} / ${total}**;hit@1 变化:**${d.stats.v2rVsV2Hit1} / ${total}**;mrr 变化:**${d.stats.v2rVsV2Mrr} / ${total}**`);
  lines.push('');
  lines.push('| qid | gt | V1 mrr | V2 mrr | V2+R mrr | V1 hit@1 | V2 hit@1 | V2+R hit@1 | V1 top1 | V2 top1 | V2+R top1 | V2+R top1 rerank_score |');
  lines.push('|---|---|---:|---:|---:|:---:|:---:|:---:|---|---|---|---:|');
  for (const dq of d.perQuestionDiffs) {
    const v1H = dq.v1Hit1 ? '✓' : '✗';
    const v2H = dq.v2Hit1 ? '✓' : '✗';
    const v2rH = dq.v2rHit1 ? '✓' : '✗';
    lines.push(
      `| ${dq.qid} | ${dq.gt} | ${fmt4(dq.v1Mrr)} | ${fmt4(dq.v2Mrr)} | ${fmt4(dq.v2rMrr)} | ${v1H} | ${v2H} | ${v2rH} | \`${dq.v1Top1Short}\` | \`${dq.v2Top1Short}\` | \`${dq.v2rTop1Short}\` | ${fmt4(dq.v2rTop1Score)} |`,
    );
  }
  lines.push('');

  // 6. Rerank 覆盖度自证
  lines.push('## 6. Rerank 覆盖度自证');
  lines.push('');
  lines.push('对 V2+R 全 44 题 top-1 `rerank_score` 求 min / median / max:反向证明 rerank 在全样本均生效。若某题 top1 rerank_score=0,该题 rerank 未真跑(需核查)。');
  lines.push('');
  lines.push(`- 样本:${d.perQuestionDiffs.length} / ${total}`);
  lines.push(`- min:${fmt4(round4(d.rerankScoreMin))}`);
  lines.push(`- median:${fmt4(round4(d.rerankScoreMedian))}`);
  lines.push(`- max:${fmt4(round4(d.rerankScoreMax))}`);
  lines.push(`- 零值题数:${d.rerankZeroCount}`);
  lines.push('');
  if (d.rerankZeroCount > 0) {
    lines.push(`> ⚠️ 有 ${d.rerankZeroCount} 题 top1 rerank_score=0,可能该题 rerank 未生效。`);
  } else {
    lines.push('> ✓ 无 0 值,rerank 在全 44 题样本均真实生效。');
  }
  lines.push('');

  // 7. 结论(诚实)
  lines.push('## 7. 结论(口径 A 诚实表述)');
  lines.push('');
  const v2VsV1Same =
    d.stats.v2VsV1Top1 === 0 && d.stats.v2VsV1Hit1 === 0 && d.stats.v2VsV1Mrr === 0;
  const v2rVsV2Same =
    d.stats.v2rVsV2Top1 === 0 && d.stats.v2rVsV2Hit1 === 0 && d.stats.v2rVsV2Mrr === 0;

  // 7.1 V2 vs V1
  lines.push('### 7.1 V2 vs V1');
  lines.push('');
  if (v2VsV1Same) {
    lines.push('V2(LangGraph + 4 工具 + 三层防护)与 V1 检索算法字节级同源,主指标全 0 差异。**Agent 化升级未劣化检索质量**,Step 25.2b 已证。');
  } else {
    lines.push(`观察到 ${d.stats.v2VsV1Top1} 题 top-1 / ${d.stats.v2VsV1Hit1} 题 hit@1 / ${d.stats.v2VsV1Mrr} 题 mrr 出现差异。同源算法不应有差异,请核查 SiliconFlow embedding 服务端稳定性或知识库变更。`);
  }
  lines.push('');

  // 7.2 V2+R vs V2(Step 26 Reranker 核心结论)
  lines.push('### 7.2 V2+Reranker vs V2(Step 26 核心结论)');
  lines.push('');
  if (v2rVsV2Same) {
    lines.push('**主指标三方持平**:V2 与 V2+Reranker 的 Top-1 / hit@1 / mrr 完全一致,Δ Recall@1 = Δ MRR = +0.0000。');
    lines.push('');
    lines.push('这**不代表 rerank 没工作**:');
    lines.push('');
    lines.push(`- 覆盖度自证:全 44 题 top-1 rerank_score median=${fmt4(round4(d.rerankScoreMedian))} / max=${fmt4(round4(d.rerankScoreMax))},零值 ${d.rerankZeroCount} 题,证明 rerank 在 44 题样本上**真实生效**`);
    lines.push('- Step 26.3 (a) vs (b) 已证 rerank 主要重排到第 5 位,前 4 位继承 pgvector 顺序;');
    lines.push('  主指标只看 hit@1 / mrr(首命中倒数),只要 top-1 不变化,数字自然不动');
    lines.push('- **样本上限触顶**:11 chunk 全集 + V2 Recall@5 已经 1.0,口径 A 没有量化提升的空间,主题 13.4 / 18.2 已预言');
    lines.push('');
    lines.push('**不造"提升 X%"的假数字**(主题 18.2)。本 Step 的价值不在数字提升,而在两点:');
    lines.push('');
    lines.push('1. **可观测性闭环**:V1↔V2↔V2+R 三方对比管道立起,后续扩库或换模型时一键复算');
    lines.push('2. **生产链路就绪**:Step 26.3 已把 rerank 接入 `search_knowledge_base` 工具(召回 20 → 精排 5,3s 超时静默回退);本评估证明该链路在评估口径下零失败');
    lines.push('');
    lines.push('**何时能看到数字提升**:扩库后 chunk 数远超 5(候选池 > top-5 集合范围),且 rerank 把首命中从原 pgvector 第 N 位拉到第 1 位时,Recall@1 / MRR 会出现可见的正向 Δ。');
  } else {
    lines.push(`**主指标出现变化**:`);
    lines.push('');
    lines.push(`- ΔRecall@1 = ${fmtDelta(dR1_v2rv2)}`);
    lines.push(`- ΔMRR = ${fmtDelta(dMrr_v2rv2)}`);
    lines.push(`- Top-1 chunk 改变:${d.stats.v2rVsV2Top1} / ${total} 题`);
    lines.push(`- hit@1 翻转:${d.stats.v2rVsV2Hit1} / ${total} 题`);
    lines.push(`- mrr 变化:${d.stats.v2rVsV2Mrr} / ${total} 题`);
    lines.push('');
    lines.push('差异归因:Reranker 把召回 top-20 精排为 top-5,改变了 top-1 的 chunk 选择(同源 embedding 之上的二阶段排序);该差异**完全归因于 Reranker**(其余链路一字未动)。');
    lines.push('');
    lines.push('诚实约束:11 chunk 全集样本量小,绝对 Δ 数字仅供参考;扩库后量级会放大,届时重跑本脚本即可重估。');
  }
  lines.push('');

  // 7.3 边界与口径
  lines.push('### 7.3 边界与口径');
  lines.push('');
  lines.push('- **口径 A**:本评估只看检索器输出(embed → RPC → rerank),**不跑 Agent 决策 / 不跑 LLM**,排除 Agent 选工具、降级路径、citation 等噪声');
  lines.push('- **章节级 ground truth**:命中规则 = chunk 章节 tags 与 `{gt, ...secondary}` Set 交集非空(非 chunk_id 精确匹配);防 chunk 重编号后口径失稳');
  lines.push('- **V1 Recall@1 现算**:从 `v1.per_question[i].retrieved[0].hit` 计算,与 V2 / V2+R 的 `hit_at_1` 字节级同口径');
  lines.push('- **复刻而非 import**:`run-v2-reranker.ts` 直接 import `lib/rag/rerank-core.ts`(纯函数,无 server-only),不通过薄包装 `lib/rag/rerank.ts`(server-only,tsx 不可直接 import)');
  lines.push('- **评估口径反向于生产**:本评估 rerank 失败 → 直接 throw 中止脚本;生产 `tools.ts` rerank 失败 → 静默回退 pgvector top-5。取向不同非 bug:评估要完整性,生产要可用性');
  lines.push('');

  return lines.join('\n');
}

try {
  main();
} catch (err) {
  console.error('[失败]', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
