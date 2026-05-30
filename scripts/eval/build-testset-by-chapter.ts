// V2 Step 22 阶段 2c — 基于章节标注重建评估测试集
//
// ⚠️ 纯本地脚本:不查数据库 / 不调 LLM / 不读 env
//    输入 = 规划者写死的常量 + 原 eval/testset.jsonl
//    输出 = eval/testset-final.jsonl + eval/chapter-tags.json
//    本文件不出现 .insert / .update / .delete / .upsert / .rpc
//
// 注意:tsx 脚本环境,不能加 'server-only'(EXPERIENCE 主题 1.2)

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── 路径常量 ───────────────────────────────────────────
const INPUT_PATH = 'eval/testset.jsonl';
const OUTPUT_TESTSET_PATH = 'eval/testset-final.jsonl';
const OUTPUT_TAGS_PATH = 'eval/chapter-tags.json';

// ─── 11 个 chunk 的章节归属(规划者基于诊断脚本段 ① 的 chunk 内容标注)──
const CHUNK_CHAPTER_TAGS: Record<string, string[]> = {
  'b445838b-78d4-45f3-abfd-d0f7bb72210a': ['1-overview', '2-specs'],
  '09f6a86f-ee71-4dd4-94b9-c7724ea6f4e9': ['2-specs', '3-install'],
  'f159405c-1ffc-43ba-81e6-d35d4ef8ff35': ['3-install', '4-app-wifi'],
  'bac87e67-1f9c-429f-b938-084aec3158c9': ['4-app-wifi', '5-cleaning'],
  '2f4d7a0f-d7b2-47d8-8926-9ffa0a657e2c': ['5-cleaning', '6-maintenance'],
  'c3b21375-a824-4117-8671-a4f9137248e7': ['6-maintenance', '7-troubleshoot'],
  '988bbb86-0e09-4f68-9956-48f8e3a40ca8': ['7-troubleshoot', '8-faq'],
  '396affb5-66b9-4c3e-a4de-63b61e738753': ['8-faq', '9-parts'],
  'f0497de7-812a-4694-8e72-26485dd5f4cc': ['9-parts', '10-warranty'],
  '7693ed68-6615-4610-af75-f52485befaf4': ['10-warranty', '11-privacy'],
  'c16dbd15-bab6-4fdc-a706-d563a0ead98b': ['11-privacy'],
};

// ─── 11 个章节代码白名单(校验用)────────────────────
const VALID_CHAPTERS: readonly string[] = [
  '1-overview',
  '2-specs',
  '3-install',
  '4-app-wifi',
  '5-cleaning',
  '6-maintenance',
  '7-troubleshoot',
  '8-faq',
  '9-parts',
  '10-warranty',
  '11-privacy',
];

// ─── 44 题章节映射:[qid, ground_truth_chapter, secondary_chapters[]] ──
const QUESTION_CHAPTER_MAP: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ['q001', '1-overview', []],
  ['q002', '1-overview', []],
  ['q003', '1-overview', []],
  ['q004', '1-overview', []],
  ['q005', '2-specs', ['3-install']],
  ['q006', '2-specs', []],
  ['q007', '3-install', []],
  ['q008', '2-specs', []],
  ['q009', '3-install', []],
  ['q010', '3-install', []],
  ['q011', '4-app-wifi', []],
  ['q012', '4-app-wifi', []],
  ['q013', '4-app-wifi', []],
  ['q014', '4-app-wifi', []],
  ['q015', '5-cleaning', []],
  ['q016', '5-cleaning', []],
  ['q017', '5-cleaning', []],
  ['q018', '5-cleaning', []],
  ['q019', '5-cleaning', []],
  ['q020', '6-maintenance', []],
  ['q021', '6-maintenance', []],
  ['q022', '6-maintenance', []],
  ['q023', '7-troubleshoot', []],
  ['q024', '7-troubleshoot', []],
  ['q025', '7-troubleshoot', []],
  ['q026', '7-troubleshoot', []],
  ['q027', '7-troubleshoot', []],
  ['q028', '8-faq', ['7-troubleshoot']],
  ['q029', '8-faq', ['7-troubleshoot']],
  ['q030', '8-faq', []],
  ['q031', '8-faq', ['5-cleaning']],
  ['q032', '8-faq', []],
  ['q033', '9-parts', []],
  ['q034', '9-parts', []],
  ['q035', '9-parts', ['10-warranty']],
  ['q036', '10-warranty', []],
  ['q037', '10-warranty', []],
  ['q038', '10-warranty', []],
  ['q039', '10-warranty', []],
  ['q040', '11-privacy', []],
  ['q041', '11-privacy', []],
  ['q042', '11-privacy', []],
  ['q043', '11-privacy', []],
  ['q044', '11-privacy', []],
];

// ─── 类型 ───────────────────────────────────────────────
type QuestionType = 'fact' | 'colloquial';

interface OriginalEntry {
  id: string;
  question: string;
  question_type: QuestionType;
  source_chunk_preview: string;
}

interface FinalEntry {
  id: string;
  question: string;
  question_type: QuestionType;
  ground_truth_chapter: string;
  secondary_chapters: string[];
  source_chunk_preview: string;
}

interface ChapterAssignment {
  gt: string;
  secondary: string[];
}

// ─── 工具 ───────────────────────────────────────────────
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
    if (typeof preview !== 'string') {
      throw new Error(`第 ${idx + 1} 行 source_chunk_preview 非字符串`);
    }
    out.push({ id, question, question_type: qt, source_chunk_preview: preview });
  });
  return out;
}

// ─── 启动校验:三关 ──────────────────────────────────
function validateAll(testsetQids: string[]): void {
  const validSet = new Set(VALID_CHAPTERS);
  const errors: string[] = [];

  // 校验 1:CHUNK_CHAPTER_TAGS 所有 value ∈ VALID_CHAPTERS
  for (const [chunkId, chapters] of Object.entries(CHUNK_CHAPTER_TAGS)) {
    for (const ch of chapters) {
      if (!validSet.has(ch)) {
        errors.push(`[校验 1] CHUNK_CHAPTER_TAGS 中 chunk ${chunkId} 的章节代码 "${ch}" 不在白名单`);
      }
    }
  }

  // 校验 2:QUESTION_CHAPTER_MAP 所有 gt + secondary ∈ VALID_CHAPTERS
  for (const [qid, gt, secondary] of QUESTION_CHAPTER_MAP) {
    if (!validSet.has(gt)) {
      errors.push(`[校验 2] ${qid} 的 ground_truth_chapter "${gt}" 不在白名单`);
    }
    for (const ch of secondary) {
      if (!validSet.has(ch)) {
        errors.push(`[校验 2] ${qid} 的 secondary_chapters 含 "${ch}",不在白名单`);
      }
    }
  }

  // 校验 3:QUESTION_CHAPTER_MAP 的 qid 集合 == testset.jsonl 的 qid 集合
  const mapQids = QUESTION_CHAPTER_MAP.map(([qid]) => qid);
  const mapQidSet = new Set<string>();
  const duplicateQids: string[] = [];
  for (const qid of mapQids) {
    if (mapQidSet.has(qid)) duplicateQids.push(qid);
    mapQidSet.add(qid);
  }
  if (duplicateQids.length > 0) {
    errors.push(`[校验 3] QUESTION_CHAPTER_MAP 含重复 qid:${duplicateQids.join(', ')}`);
  }

  const testsetQidSet = new Set(testsetQids);
  const missingInTestset: string[] = [];
  const missingInMap: string[] = [];
  for (const qid of mapQidSet) {
    if (!testsetQidSet.has(qid)) missingInTestset.push(qid);
  }
  for (const qid of testsetQidSet) {
    if (!mapQidSet.has(qid)) missingInMap.push(qid);
  }
  if (mapQidSet.size !== testsetQidSet.size) {
    errors.push(
      `[校验 3] qid 数量不匹配:QUESTION_CHAPTER_MAP=${mapQidSet.size}, testset.jsonl=${testsetQidSet.size}`,
    );
  }
  if (missingInTestset.length > 0) {
    errors.push(`[校验 3] map 里有但 testset 缺失:${missingInTestset.join(', ')}`);
  }
  if (missingInMap.length > 0) {
    errors.push(`[校验 3] testset 里有但 map 缺失:${missingInMap.join(', ')}`);
  }

  if (errors.length > 0) {
    console.error('[失败] 启动校验未通过:');
    for (const e of errors) console.error(`  · ${e}`);
    process.exit(1);
  }
}

// ─── 主流程 ─────────────────────────────────────────
function main(): void {
  console.log('═'.repeat(70));
  console.log('V2 Step 22 阶段 2c — 基于章节标注重建评估测试集');
  console.log('═'.repeat(70));
  console.log(`输入   = ${INPUT_PATH}`);
  console.log(`输出 1 = ${OUTPUT_TESTSET_PATH}`);
  console.log(`输出 2 = ${OUTPUT_TAGS_PATH}\n`);

  // ② 读 testset.jsonl
  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`[失败] 找不到输入文件 ${INPUT_PATH}`);
    process.exit(1);
  }
  const rawText = fs.readFileSync(INPUT_PATH, 'utf8');
  const originals = parseOriginalEntries(rawText);
  if (originals.length === 0) {
    console.error('[失败] testset.jsonl 为空');
    process.exit(1);
  }
  console.log(`读取到 ${originals.length} 道题\n`);

  // ① 启动校验
  validateAll(originals.map((e) => e.id));
  console.log('✅ 启动校验通过(章节白名单 + qid 集合一致 + 无重复)\n');

  // ③ 构造 qid → ChapterAssignment
  const assignmentByQid = new Map<string, ChapterAssignment>();
  for (const [qid, gt, secondary] of QUESTION_CHAPTER_MAP) {
    assignmentByQid.set(qid, { gt, secondary: [...secondary] });
  }

  // ④ 按 testset.jsonl 原顺序组装 FinalEntry[]
  const finals: FinalEntry[] = originals.map((e) => {
    const a = assignmentByQid.get(e.id);
    if (!a) {
      // 校验 3 已保证 100% 命中,这里防御性兜底
      throw new Error(`assignmentByQid 缺失 ${e.id}(理论不应发生)`);
    }
    return {
      id: e.id,
      question: e.question,
      question_type: e.question_type,
      ground_truth_chapter: a.gt,
      secondary_chapters: [...a.secondary],
      source_chunk_preview: e.source_chunk_preview,
    };
  });

  // ⑤ 写盘
  fs.mkdirSync(path.dirname(OUTPUT_TESTSET_PATH), { recursive: true });
  const jsonl = finals.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(OUTPUT_TESTSET_PATH, jsonl, 'utf8');

  fs.mkdirSync(path.dirname(OUTPUT_TAGS_PATH), { recursive: true });
  fs.writeFileSync(
    OUTPUT_TAGS_PATH,
    JSON.stringify(CHUNK_CHAPTER_TAGS, null, 2) + '\n',
    'utf8',
  );

  // ⑥ stdout 汇总报告
  console.log(`${'═'.repeat(70)}`);
  console.log('汇总报告');
  console.log('═'.repeat(70));

  console.log(`\n共处理 ${finals.length} 题\n`);

  // 章节分布(降序)
  const gtCount = new Map<string, number>();
  for (const ch of VALID_CHAPTERS) gtCount.set(ch, 0);
  for (const f of finals) gtCount.set(f.ground_truth_chapter, (gtCount.get(f.ground_truth_chapter) ?? 0) + 1);
  const sorted = [...gtCount.entries()].sort((a, b) => b[1] - a[1]);
  const total = finals.length;
  console.log('— 章节分布(作为 ground_truth_chapter 的题数,降序):');
  for (const [ch, n] of sorted) {
    if (n === 0) continue;
    const pct = ((n / total) * 100).toFixed(1);
    console.log(`  ${ch.padEnd(16)} ${String(n).padStart(3)} 题  (${pct}%)`);
  }
  const zeros = sorted.filter(([, n]) => n === 0).map(([ch]) => ch);
  if (zeros.length > 0) {
    console.log(`  (零覆盖章节:${zeros.join(', ')})`);
  }

  // 带 secondary 的题数
  const withSecondary = finals.filter((f) => f.secondary_chapters.length > 0);
  console.log(`\n— 带 secondary_chapters 的题:${withSecondary.length} / ${total}`);
  for (const f of withSecondary) {
    console.log(`  ${f.id}  gt=${f.ground_truth_chapter}  secondary=[${f.secondary_chapters.join(', ')}]`);
  }

  // question_type 分布
  const factCount = finals.filter((f) => f.question_type === 'fact').length;
  const colloquialCount = finals.filter((f) => f.question_type === 'colloquial').length;
  console.log(`\n— question_type 分布:fact=${factCount} / colloquial=${colloquialCount}`);

  // 写入文件列表
  console.log(`\n— 写入文件:`);
  console.log(`  ${OUTPUT_TESTSET_PATH}  (${finals.length} 行 JSONL)`);
  console.log(`  ${OUTPUT_TAGS_PATH}  (${Object.keys(CHUNK_CHAPTER_TAGS).length} 个 chunk 章节标签)`);

  console.log(`\n${'═'.repeat(70)}`);
  console.log('✅ 完成。原 testset.jsonl / testset-relabeled.jsonl 未改动。');
  console.log('═'.repeat(70));
}

try {
  main();
} catch (err) {
  console.error('[失败]', err);
  process.exit(1);
}
