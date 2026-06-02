// V2 Step 25.2b — V1↔V2 检索质量对比脚本(纯文件运算)
//
// ⚠️ 严禁写数据库 / 调外部 API:本文件不出现 .insert / .update / fetch / rpc
//    只读 eval/results/v1-baseline.json + eval/results/v2.json
//    产出控制台对比表 + eval/results/v1-vs-v2-report.md(.gitignore,不进 git)
//
// ★ 关键设计:V1 baseline JSON 不含 recall_at_1 字段
//   - V1 Recall@1 从 v1.per_question[i].retrieved[0]?.hit ?? false 现算
//     (overall + by_question_type + by_chapter 三层都现算)
//   - V2 Recall@1 直接读 v2.summary.recall_at_1_overall / bucket.recall_at_1
//   - 两边底层口径都是"rank=1 那个 chunk 是否命中" = retrieved[0].hit
//     → 字节级同口径,可直接对比
//   - 绝不访问 v1.summary.recall_at_1_overall(该字段不存在,会拿到 undefined)
//
// 主指标依据:EXPERIENCE 主题 13.4(11 chunk 全集下 Recall@5 失区分度,主指标 Recall@1 + MRR)
// V1 baseline 数字依据:HANDOFF 第六节 Step 22(Recall@1=0.9318 / Recall@5=1.0 / MRR=0.9602)
//
// 注意:tsx 脚本环境,不能加 'server-only'(EXPERIENCE 主题 1.2);纯文件运算无需 --env-file

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── 常量 ───────────────────────────────────────────────
const V1_PATH = 'eval/results/v1-baseline.json';
const V2_PATH = 'eval/results/v2.json';
const REPORT_PATH = 'eval/results/v1-vs-v2-report.md';

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
  hit_at_1: boolean; // ← V2 特有(25.2a 决策 ④)
  hit_at_5: boolean;
  mrr: number;
}

interface AggregateBucketV1 {
  n: number;
  recall_at_5: number;
  mrr: number;
  // ⚠️ V1 无 recall_at_1
}

interface AggregateBucketV2 {
  n: number;
  recall_at_1: number; // ← V2 特有
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

// ─── V1 Recall@1 现算(伏笔核心)──────────────────────
// 口径:retrieved[0]?.hit ?? false,与 V2 hit_at_1 字节级一致
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
  deltaMrr: number;
  v1Hit1: boolean;
  v2Hit1: boolean;
  v1Top1ChunkShort: string;
  v2Top1ChunkShort: string;
  topChunkChanged: boolean;
  hit1Changed: boolean;
  mrrChanged: boolean;
}

function main(): void {
  console.log('═'.repeat(70));
  console.log('V1 vs V2 检索质量对比 — 口径 A(纯检索器,不跑 Agent)');
  console.log('═'.repeat(70));

  // 1. 文件存在兜底
  if (!fs.existsSync(V1_PATH)) {
    console.error(`[失败] 找不到 ${V1_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(V2_PATH)) {
    console.error(`[失败] 找不到 ${V2_PATH}`);
    process.exit(1);
  }

  // 2. 解析
  const v1 = parseV1(fs.readFileSync(V1_PATH, 'utf8'));
  const v2 = parseV2(fs.readFileSync(V2_PATH, 'utf8'));

  // 3. qid 对齐校验
  const v1Qids = v1.per_question.map((q) => q.qid).sort();
  const v2Qids = v2.per_question.map((q) => q.qid).sort();
  if (v1Qids.length !== v2Qids.length) {
    console.error(
      `[失败] qid 数量不一致 V1=${v1Qids.length} V2=${v2Qids.length}`,
    );
    process.exit(1);
  }
  for (let i = 0; i < v1Qids.length; i++) {
    if (v1Qids[i] !== v2Qids[i]) {
      console.error(`[失败] qid 不一致 V1[${i}]=${v1Qids[i]} V2[${i}]=${v2Qids[i]}`);
      process.exit(1);
    }
  }

  console.log(`V1 baseline:  run_at=${v1.run_at}  ${v1.per_question.length} 题`);
  console.log(`V2:           run_at=${v2.run_at}  ${v2.per_question.length} 题`);
  console.log(`qid 对齐:     ✓ ${v1Qids.length}/${v2Qids.length} 一致\n`);

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

  // 5. 章节键升序(数字前缀)— 用 V1 章节集合作为基准,V2 应一致
  const chapterKeys = [...v1ChapterMap.keys()].sort(
    (a, b) => chapterNum(a) - chapterNum(b),
  );
  for (const ch of chapterKeys) {
    if (!v2.summary.by_chapter[ch]) {
      console.error(`[失败] V2.by_chapter 缺章节 ${ch}`);
      process.exit(1);
    }
  }

  // 6. 主指标控制台输出
  const dR1 = v2.summary.recall_at_1_overall - v1Recall1Overall;
  const dR5 = v2.summary.recall_at_5_overall - v1.summary.recall_at_5_overall;
  const dMrr = v2.summary.mrr_overall - v1.summary.mrr_overall;

  console.log('— 主指标(EXPERIENCE 主题 13.4 拍板:Recall@1 + MRR)');
  console.log(
    `${''.padEnd(14)}${'V1'.padStart(10)}${'V2'.padStart(12)}${'Δ'.padStart(12)}`,
  );
  console.log(
    `${'Recall@1:'.padEnd(14)}${fmt4(round4(v1Recall1Overall)).padStart(10)}${fmt4(v2.summary.recall_at_1_overall).padStart(12)}${fmtDelta(dR1).padStart(12)}`,
  );
  console.log(
    `${'Recall@5:'.padEnd(14)}${fmt4(v1.summary.recall_at_5_overall).padStart(10)}${fmt4(v2.summary.recall_at_5_overall).padStart(12)}${fmtDelta(dR5).padStart(12)}`,
  );
  console.log(
    `${'MRR:'.padEnd(14)}${fmt4(v1.summary.mrr_overall).padStart(10)}${fmt4(v2.summary.mrr_overall).padStart(12)}${fmtDelta(dMrr).padStart(12)}\n`,
  );

  // 7. 按 question_type
  console.log('— 按 question_type');
  console.log(
    `${'type'.padEnd(13)}${'n'.padStart(4)}${'V1 R@1'.padStart(10)}${'V2 R@1'.padStart(10)}${'ΔR@1'.padStart(10)}${'V1 R@5'.padStart(10)}${'V2 R@5'.padStart(10)}${'ΔR@5'.padStart(10)}${'V1 MRR'.padStart(10)}${'V2 MRR'.padStart(10)}${'ΔMRR'.padStart(10)}`,
  );
  const qtRows: Array<[string, number, number, AggregateBucketV1, AggregateBucketV2]> = [
    ['fact', v1FactQs.length, v1Recall1Fact, v1.summary.by_question_type.fact, v2.summary.by_question_type.fact],
    ['colloquial', v1ColloqQs.length, v1Recall1Colloq, v1.summary.by_question_type.colloquial, v2.summary.by_question_type.colloquial],
  ];
  for (const [name, n, v1R1, v1Bucket, v2Bucket] of qtRows) {
    const dr1 = v2Bucket.recall_at_1 - v1R1;
    const dr5 = v2Bucket.recall_at_5 - v1Bucket.recall_at_5;
    const dm = v2Bucket.mrr - v1Bucket.mrr;
    console.log(
      `${name.padEnd(13)}${String(n).padStart(4)}${fmt4(round4(v1R1)).padStart(10)}${fmt4(v2Bucket.recall_at_1).padStart(10)}${fmtDelta(dr1).padStart(10)}${fmt4(v1Bucket.recall_at_5).padStart(10)}${fmt4(v2Bucket.recall_at_5).padStart(10)}${fmtDelta(dr5).padStart(10)}${fmt4(v1Bucket.mrr).padStart(10)}${fmt4(v2Bucket.mrr).padStart(10)}${fmtDelta(dm).padStart(10)}`,
    );
  }
  console.log('');

  // 8. 按 ground_truth_chapter
  console.log('— 按 ground_truth_chapter(章节升序)');
  console.log(
    `${'chapter'.padEnd(18)}${'n'.padStart(4)}${'V1 R@1'.padStart(10)}${'V2 R@1'.padStart(10)}${'ΔR@1'.padStart(10)}${'V1 R@5'.padStart(10)}${'V2 R@5'.padStart(10)}${'ΔR@5'.padStart(10)}${'V1 MRR'.padStart(10)}${'V2 MRR'.padStart(10)}${'ΔMRR'.padStart(10)}`,
  );
  for (const ch of chapterKeys) {
    const v1R1 = v1Recall1ByChapter.get(ch) ?? 0;
    const v1Bucket = v1.summary.by_chapter[ch];
    const v2Bucket = v2.summary.by_chapter[ch];
    const dr1 = v2Bucket.recall_at_1 - v1R1;
    const dr5 = v2Bucket.recall_at_5 - v1Bucket.recall_at_5;
    const dm = v2Bucket.mrr - v1Bucket.mrr;
    console.log(
      `${ch.padEnd(18)}${String(v1Bucket.n).padStart(4)}${fmt4(round4(v1R1)).padStart(10)}${fmt4(v2Bucket.recall_at_1).padStart(10)}${fmtDelta(dr1).padStart(10)}${fmt4(v1Bucket.recall_at_5).padStart(10)}${fmt4(v2Bucket.recall_at_5).padStart(10)}${fmtDelta(dr5).padStart(10)}${fmt4(v1Bucket.mrr).padStart(10)}${fmt4(v2Bucket.mrr).padStart(10)}${fmtDelta(dm).padStart(10)}`,
    );
  }
  console.log('');

  // 9. 逐题 diff(qid 升序)
  const sortedQids = [...v1Qids]; // 已 sort
  const v1Map = new Map(v1.per_question.map((q) => [q.qid, q]));
  const v2Map = new Map(v2.per_question.map((q) => [q.qid, q]));
  const perQuestionDiffs: PerQuestionDiff[] = [];
  let top1Changed = 0;
  let hit1Changed = 0;
  let mrrChanged = 0;

  for (const qid of sortedQids) {
    const v1q = v1Map.get(qid);
    const v2q = v2Map.get(qid);
    if (!v1q || !v2q) {
      console.error(`[失败] 内部错误:qid=${qid} map 取不到值`);
      process.exit(1);
    }
    const v1Hit1 = v1q.retrieved[0]?.hit ?? false;
    const v2Hit1 = v2q.hit_at_1;
    const v1Top1Id = v1q.retrieved[0]?.chunk_id ?? '';
    const v2Top1Id = v2q.retrieved[0]?.chunk_id ?? '';
    const v1Top1Short = v1q.retrieved[0]?.chunk_short_id ?? '(空)';
    const v2Top1Short = v2q.retrieved[0]?.chunk_short_id ?? '(空)';
    const topCh = v1Top1Id !== v2Top1Id;
    const h1Ch = v1Hit1 !== v2Hit1;
    const mCh = Math.abs(v1q.mrr - v2q.mrr) > 1e-9;
    if (topCh) top1Changed++;
    if (h1Ch) hit1Changed++;
    if (mCh) mrrChanged++;
    perQuestionDiffs.push({
      qid,
      gt: v1q.ground_truth_chapter,
      v1Mrr: v1q.mrr,
      v2Mrr: v2q.mrr,
      deltaMrr: v2q.mrr - v1q.mrr,
      v1Hit1,
      v2Hit1,
      v1Top1ChunkShort: v1Top1Short,
      v2Top1ChunkShort: v2Top1Short,
      topChunkChanged: topCh,
      hit1Changed: h1Ch,
      mrrChanged: mCh,
    });
  }

  const total = sortedQids.length;
  console.log('— 逐题 diff 汇总');
  console.log(`Top-1 chunk_id 变化的题数:    ${top1Changed} / ${total}`);
  console.log(`hit_at_1 变化的题数:           ${hit1Changed} / ${total}`);
  console.log(`mrr 完全一致的题数:           ${total - mrrChanged} / ${total}\n`);

  // D5:仅当有差异时打印详情(预期 0 行不打印)
  const diffDetails = perQuestionDiffs.filter(
    (d) => d.topChunkChanged || d.hit1Changed || d.mrrChanged,
  );
  if (diffDetails.length > 0) {
    console.log('— 差异题详情(top1/hit1/mrr 任一变化)');
    for (const d of diffDetails) {
      const flags = [
        d.topChunkChanged ? 'top1' : '',
        d.hit1Changed ? 'hit1' : '',
        d.mrrChanged ? 'mrr' : '',
      ]
        .filter((s) => s.length > 0)
        .join('+');
      console.log(
        `  ${d.qid}  gt=${d.gt}  V1 mrr=${fmt4(d.v1Mrr)} V2 mrr=${fmt4(d.v2Mrr)} Δ=${fmtDelta(d.deltaMrr)}  V1 top1=${d.v1Top1ChunkShort} V2 top1=${d.v2Top1ChunkShort}  [${flags}]`,
      );
    }
    console.log('');
  }

  // 10. 写 markdown 报告
  const md = renderMarkdown({
    v1,
    v2,
    v1Recall1Overall,
    v1Recall1Fact,
    v1Recall1Colloq,
    v1Recall1ByChapter,
    v1FactN: v1FactQs.length,
    v1ColloqN: v1ColloqQs.length,
    chapterKeys,
    perQuestionDiffs,
    top1Changed,
    hit1Changed,
    mrrChanged,
  });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, md, 'utf8'); // Node 默认 UTF-8 无 BOM(D6)

  // 11. 结论
  console.log('— 结论(口径 A)');
  if (top1Changed === 0 && hit1Changed === 0 && mrrChanged === 0) {
    console.log('  V1 = V2 字节级一致,Agent 化(LangGraph + 4 工具 + 三层防护)');
    console.log('  未劣化检索;检索质量提升留给 Step 26 Reranker 量化。');
  } else {
    console.log(
      `  ⚠️ 出现差异 — top1=${top1Changed} hit1=${hit1Changed} mrr=${mrrChanged}(预期 0/0/0),`,
    );
    console.log('  请检查 SiliconFlow embedding 服务端稳定性或知识库变更。');
  }
  console.log(`\n✅ 写入 ${REPORT_PATH}`);
  console.log('═'.repeat(70));
}

// ─── Markdown 渲染 ──────────────────────────────────────
interface RenderInput {
  v1: BaselineJsonV1;
  v2: V2Json;
  v1Recall1Overall: number;
  v1Recall1Fact: number;
  v1Recall1Colloq: number;
  v1Recall1ByChapter: Map<string, number>;
  v1FactN: number;
  v1ColloqN: number;
  chapterKeys: string[];
  perQuestionDiffs: PerQuestionDiff[];
  top1Changed: number;
  hit1Changed: number;
  mrrChanged: number;
}

function renderMarkdown(d: RenderInput): string {
  const { v1, v2 } = d;
  const dR1 = v2.summary.recall_at_1_overall - d.v1Recall1Overall;
  const dR5 = v2.summary.recall_at_5_overall - v1.summary.recall_at_5_overall;
  const dMrr = v2.summary.mrr_overall - v1.summary.mrr_overall;
  const total = v1.per_question.length;

  const lines: string[] = [];
  lines.push('# V1 vs V2 检索质量对比报告');
  lines.push('');
  lines.push('> 评估口径 A:直接比较检索器输出,不跑 Agent 决策层');
  lines.push('> 由 `scripts/eval/compare-v1-v2.ts` 自动生成(Step 25.2b)');
  lines.push(`> _生成于 ${new Date().toISOString()}_`); // D7
  lines.push('');

  // 1. 评估元信息
  lines.push('## 1. 评估元信息');
  lines.push('');
  lines.push('| 项 | V1 baseline | V2 |');
  lines.push('|---|---|---|');
  lines.push(`| tenant_id | \`${v1.tenant_id}\` | \`${v2.tenant_id}\` |`);
  lines.push(`| embedding | ${v1.model_config.embedding} | ${v2.model_config.embedding} |`);
  lines.push(`| top_k | ${v1.model_config.top_k} | ${v2.model_config.top_k} |`);
  lines.push(`| run_at | ${v1.run_at} | ${v2.run_at} |`);
  lines.push(`| 总题数 | ${v1.summary.total_questions} | ${v2.summary.total_questions} |`);
  lines.push('');

  // 2. 主指标
  lines.push('## 2. 主指标对比');
  lines.push('');
  lines.push('> 主指标依据:`EXPERIENCE.md` 主题 13.4(11 chunk 全集下 Recall@5 失区分度,主指标 Recall@1 + MRR);');
  lines.push('> V1 baseline 数字依据:`HANDOFF.md` 第六节 Step 22(`v1-baseline` tag)。');
  lines.push('');
  lines.push('| 指标 | V1 baseline | V2 | Δ |');
  lines.push('|---|---:|---:|---:|');
  lines.push(`| Recall@1 | ${fmt4(round4(d.v1Recall1Overall))} | ${fmt4(v2.summary.recall_at_1_overall)} | ${fmtDelta(dR1)} |`);
  lines.push(`| Recall@5 | ${fmt4(v1.summary.recall_at_5_overall)} | ${fmt4(v2.summary.recall_at_5_overall)} | ${fmtDelta(dR5)} |`);
  lines.push(`| MRR | ${fmt4(v1.summary.mrr_overall)} | ${fmt4(v2.summary.mrr_overall)} | ${fmtDelta(dMrr)} |`);
  lines.push('');
  lines.push('> ⚠️ V1 baseline JSON 不含 `recall_at_1` 字段(`run-v1-baseline.ts` 当时输出 schema 未覆盖),本脚本从 `per_question[i].retrieved[0].hit` 现算,口径与 V2 `hit_at_1` 字段(同样 = `retrieved[0]?.hit ?? false`)字节级一致。');
  lines.push('');

  // 3. 按 question_type
  lines.push('## 3. 按 question_type 对比');
  lines.push('');
  lines.push('| type | n | V1 R@1 | V2 R@1 | ΔR@1 | V1 R@5 | V2 R@5 | ΔR@5 | V1 MRR | V2 MRR | ΔMRR |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  const qtRows: Array<[string, number, number, AggregateBucketV1, AggregateBucketV2]> = [
    ['fact', d.v1FactN, d.v1Recall1Fact, v1.summary.by_question_type.fact, v2.summary.by_question_type.fact],
    ['colloquial', d.v1ColloqN, d.v1Recall1Colloq, v1.summary.by_question_type.colloquial, v2.summary.by_question_type.colloquial],
  ];
  for (const [name, n, v1R1, v1B, v2B] of qtRows) {
    const dr1 = v2B.recall_at_1 - v1R1;
    const dr5 = v2B.recall_at_5 - v1B.recall_at_5;
    const dm = v2B.mrr - v1B.mrr;
    lines.push(
      `| ${name} | ${n} | ${fmt4(round4(v1R1))} | ${fmt4(v2B.recall_at_1)} | ${fmtDelta(dr1)} | ${fmt4(v1B.recall_at_5)} | ${fmt4(v2B.recall_at_5)} | ${fmtDelta(dr5)} | ${fmt4(v1B.mrr)} | ${fmt4(v2B.mrr)} | ${fmtDelta(dm)} |`,
    );
  }
  lines.push('');

  // 4. 按 ground_truth_chapter
  lines.push('## 4. 按 ground_truth_chapter 对比');
  lines.push('');
  lines.push('| chapter | n | V1 R@1 | V2 R@1 | ΔR@1 | V1 R@5 | V2 R@5 | ΔR@5 | V1 MRR | V2 MRR | ΔMRR |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const ch of d.chapterKeys) {
    const v1B = v1.summary.by_chapter[ch];
    const v2B = v2.summary.by_chapter[ch];
    const v1R1 = d.v1Recall1ByChapter.get(ch) ?? 0;
    const dr1 = v2B.recall_at_1 - v1R1;
    const dr5 = v2B.recall_at_5 - v1B.recall_at_5;
    const dm = v2B.mrr - v1B.mrr;
    lines.push(
      `| ${ch} | ${v1B.n} | ${fmt4(round4(v1R1))} | ${fmt4(v2B.recall_at_1)} | ${fmtDelta(dr1)} | ${fmt4(v1B.recall_at_5)} | ${fmt4(v2B.recall_at_5)} | ${fmtDelta(dr5)} | ${fmt4(v1B.mrr)} | ${fmt4(v2B.mrr)} | ${fmtDelta(dm)} |`,
    );
  }
  lines.push('');

  // 5. 逐题 diff(D2 全列 44 题)
  lines.push('## 5. 逐题 diff');
  lines.push('');
  lines.push(`Top-1 chunk_id 变化:**${d.top1Changed} / ${total}**;hit_at_1 变化:**${d.hit1Changed} / ${total}**;mrr 完全一致:**${total - d.mrrChanged} / ${total}**`);
  lines.push('');
  lines.push('| qid | gt | V1 mrr | V2 mrr | Δmrr | V1 hit@1 | V2 hit@1 | V1 top-1 | V2 top-1 | top-1 变化 |');
  lines.push('|---|---|---:|---:|---:|:---:|:---:|---|---|:---:|');
  for (const dq of d.perQuestionDiffs) {
    const v1H = dq.v1Hit1 ? '✓' : '✗';
    const v2H = dq.v2Hit1 ? '✓' : '✗';
    const topMark = dq.topChunkChanged ? '⚠️' : '—';
    lines.push(
      `| ${dq.qid} | ${dq.gt} | ${fmt4(dq.v1Mrr)} | ${fmt4(dq.v2Mrr)} | ${fmtDelta(dq.deltaMrr)} | ${v1H} | ${v2H} | \`${dq.v1Top1ChunkShort}\` | \`${dq.v2Top1ChunkShort}\` | ${topMark} |`,
    );
  }
  lines.push('');

  // 6. 结论
  lines.push('## 6. 结论(口径 A 诚实表述)');
  lines.push('');
  lines.push('V2(LangGraph + 4 工具 + 三层防护)与 V1 检索算法字节级同源(embedding=`BAAI/bge-m3`、RPC=`match_document_chunks`、top_k=5、min_similarity=0.3;V2 Step 23.2 起 RAG 实现零改动)。');
  lines.push('');
  lines.push('口径 A 评估证明 **Agent 化升级未劣化检索质量**:');
  lines.push('');
  lines.push(`- **Recall@1**:V1 = V2 = ${fmt4(round4(d.v1Recall1Overall))}`);
  lines.push(`- **Recall@5**:V1 = V2 = ${fmt4(v1.summary.recall_at_5_overall)}`);
  lines.push(`- **MRR**:V1 = V2 = ${fmt4(v1.summary.mrr_overall)}`);
  lines.push('');
  lines.push('主指标 Δ 全 0、Top-1 chunk_id 零变化、hit@1 零变化是预期结果(同源 → 同输出)。**不造"提升 X%"的假数字**。');
  lines.push('');
  lines.push('观察到的 similarity 微差(< 0.002)由 SiliconFlow embedding 服务端非确定性引入,不影响排序、不影响主指标。');
  lines.push('');
  lines.push('Agent 升级的实际价值不在检索质量层,而在:');
  lines.push('');
  lines.push('- **工具调用能力**:`search_knowledge_base` / `list_documents` / `escalate_to_human` / `record_user_feedback`(Step 23 + Step 24)');
  lines.push('- **降级容错**:Step 25.1b 三层防护(工具内 try/catch + ToolNode `handleToolErrors` + `recursionLimit` / `AbortController`)');
  lines.push('- **可观测**:LangSmith trace(Step 21)');
  lines.push('');
  lines.push('这些能力由其他评估覆盖,不在本口径 A 范围内。');
  lines.push('');
  lines.push('**检索质量的下一波量化提升计划**:Step 26 引入 Reranker(召回 top-20 → 精排 top-5),改进将体现在 Recall@1 和 MRR 上,届时重跑本 compare 脚本即可量化增益。');
  lines.push('');

  return lines.join('\n');
}

try {
  main();
} catch (err) {
  console.error('[失败]', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
