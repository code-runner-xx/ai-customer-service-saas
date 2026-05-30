// V2 Step 22 后置诊断 — 重新聚合 v1-baseline.json 的精细化指标
//
// 纯本地脚本:只读 eval/results/v1-baseline.json,
// 不调 LLM / DB / env,不写文件,所有结果输出到 stdout。
//
// 命中规则与 run-v1-baseline.ts 完全一致:
//   retrieved[rank-1].chapter_tags 与 (ground_truth_chapter ∪ secondary_chapters) 有交集

import * as fs from 'node:fs';

const INPUT_PATH = 'eval/results/v1-baseline.json';

// ─── 类型(与 run-v1-baseline.ts 输出对齐)────────────────────────
type QuestionType = 'fact' | 'colloquial';

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
  hit_at_5: boolean;
  mrr: number;
}

interface BaselineFile {
  per_question: PerQuestion[];
}

// ─── 工具 ─────────────────────────────────────────────────────────
function r4(x: number): string {
  return x.toFixed(4);
}

function chapterNum(code: string): number {
  const m = code.match(/^(\d+)-/);
  return m ? parseInt(m[1], 10) : 9999;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ─── 读入 + 极简校验 ──────────────────────────────────────────────
function loadBaseline(path: string): PerQuestion[] {
  if (!fs.existsSync(path)) {
    console.error(`[失败] 找不到 ${path}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[失败] ${path} JSON 解析失败:${msg}`);
    process.exit(1);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.per_question)) {
    console.error(`[失败] ${path} 结构异常,缺少 per_question 数组`);
    process.exit(1);
  }
  return parsed.per_question as PerQuestion[];
}

// ─── 指标计算 ─────────────────────────────────────────────────────
function recallAtK(qs: PerQuestion[], k: number): number {
  if (qs.length === 0) return 0;
  let hit = 0;
  for (const q of qs) {
    if (q.retrieved.slice(0, k).some((r) => r.hit)) hit++;
  }
  return hit / qs.length;
}

function mrrOverall(qs: PerQuestion[]): number {
  if (qs.length === 0) return 0;
  return qs.reduce((s, q) => s + q.mrr, 0) / qs.length;
}

interface SimStats {
  n: number;
  min: number;
  max: number;
  avg: number;
}

function simStats(values: number[]): SimStats {
  if (values.length === 0) return { n: 0, min: 0, max: 0, avg: 0 };
  let mn = Infinity;
  let mx = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    sum += v;
  }
  return { n: values.length, min: mn, max: mx, avg: sum / values.length };
}

// ─── 主流程 ───────────────────────────────────────────────────────
function main(): void {
  const qs = loadBaseline(INPUT_PATH);
  const total = qs.length;

  console.log('═'.repeat(72));
  console.log('V1 baseline 精细化诊断(只读 eval/results/v1-baseline.json)');
  console.log('═'.repeat(72));
  console.log(`总题数:${total}\n`);

  // ── 1-5: Recall@K + MRR 总体 ──
  console.log('— [1-5] Recall@K + MRR(总体)');
  console.log(`  Recall@1   = ${r4(recallAtK(qs, 1))}`);
  console.log(`  Recall@2   = ${r4(recallAtK(qs, 2))}`);
  console.log(`  Recall@3   = ${r4(recallAtK(qs, 3))}`);
  console.log(`  Recall@5   = ${r4(recallAtK(qs, 5))}  (对照,应 = 1.0000)`);
  console.log(`  MRR        = ${r4(mrrOverall(qs))}  (对照,应 ≈ 0.9602)\n`);

  // ── 6: rank 分布(首次命中位置)──
  console.log('— [6] 首次命中 rank 分布');
  const rankDist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let allMiss = 0;
  for (const q of qs) {
    const firstHitIdx = q.retrieved.findIndex((r) => r.hit);
    if (firstHitIdx === -1) {
      allMiss++;
    } else {
      const rk = q.retrieved[firstHitIdx].rank;
      rankDist[rk] = (rankDist[rk] ?? 0) + 1;
    }
  }
  for (const rk of [1, 2, 3, 4, 5]) {
    const n = rankDist[rk] ?? 0;
    const pct = total === 0 ? 0 : n / total;
    console.log(`  首命中 rank=${rk}  : ${String(n).padStart(2)} 题  (${r4(pct)})`);
  }
  console.log(`  全 miss        : ${String(allMiss).padStart(2)} 题  (${r4(total === 0 ? 0 : allMiss / total)})\n`);

  // ── 7: 每题命中 chunk 数分布 ──
  console.log('— [7] 每题 top-5 中命中 chunk 数分布(召回精度)');
  const hitCountDist: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let hitCountSum = 0;
  for (const q of qs) {
    const c = q.retrieved.filter((r) => r.hit).length;
    hitCountDist[c] = (hitCountDist[c] ?? 0) + 1;
    hitCountSum += c;
  }
  for (const c of [0, 1, 2, 3, 4, 5]) {
    const n = hitCountDist[c] ?? 0;
    const pct = total === 0 ? 0 : n / total;
    console.log(`  命中 ${c} 个      : ${String(n).padStart(2)} 题  (${r4(pct)})`);
  }
  console.log(`  平均命中数     : ${r4(total === 0 ? 0 : hitCountSum / total)} / 5\n`);

  // ── 8: 相似度分布 ──
  console.log('— [8] chunk 相似度分布(命中 vs 未命中)');
  const hitSims: number[] = [];
  const missSims: number[] = [];
  for (const q of qs) {
    for (const r of q.retrieved) {
      if (r.hit) hitSims.push(r.similarity);
      else missSims.push(r.similarity);
    }
  }
  const hs = simStats(hitSims);
  const ms = simStats(missSims);
  console.log(`  命中 chunk     n=${String(hs.n).padStart(3)}  min=${r4(hs.min)}  max=${r4(hs.max)}  avg=${r4(hs.avg)}`);
  console.log(`  未命中 chunk   n=${String(ms.n).padStart(3)}  min=${r4(ms.min)}  max=${r4(ms.max)}  avg=${r4(ms.avg)}`);
  console.log(`  avg 差值        ${r4(hs.avg - ms.avg)}(>0 越大,说明检索器越能把对的 chunk 排前)\n`);

  // ── 9: 按 question_type ──
  console.log('— [9] 按 question_type:Recall@K');
  const factQs = qs.filter((q) => q.question_type === 'fact');
  const colQs = qs.filter((q) => q.question_type === 'colloquial');
  const labelFmt = (s: string): string => s.padEnd(12);
  console.log(`  ${labelFmt('type')}  n  Recall@1  Recall@2  Recall@3  Recall@5  MRR`);
  for (const [name, sub] of [
    ['fact', factQs] as const,
    ['colloquial', colQs] as const,
  ]) {
    console.log(
      `  ${labelFmt(name)} ${String(sub.length).padStart(2)}  ${r4(recallAtK(sub, 1))}    ${r4(recallAtK(sub, 2))}    ${r4(recallAtK(sub, 3))}    ${r4(recallAtK(sub, 5))}    ${r4(mrrOverall(sub))}`,
    );
  }
  console.log('');

  // ── 10: 按 chapter ──
  console.log('— [10] 按 ground_truth_chapter:Recall@1(章节代码升序)');
  const byCh = new Map<string, PerQuestion[]>();
  for (const q of qs) {
    const list = byCh.get(q.ground_truth_chapter) ?? [];
    list.push(q);
    byCh.set(q.ground_truth_chapter, list);
  }
  const sortedKeys = [...byCh.keys()].sort((a, b) => chapterNum(a) - chapterNum(b));
  console.log(`  ${'chapter'.padEnd(16)}  n  Recall@1  Recall@5  MRR`);
  for (const ch of sortedKeys) {
    const list = byCh.get(ch);
    if (!list) continue;
    console.log(
      `  ${ch.padEnd(16)} ${String(list.length).padStart(2)}  ${r4(recallAtK(list, 1))}    ${r4(recallAtK(list, 5))}    ${r4(mrrOverall(list))}`,
    );
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log('诊断完成,无写盘');
  console.log('═'.repeat(72));
}

main();
