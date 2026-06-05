// V2 Step 27.5.1 — 拒答行为评估脚本(prefix baseline / postfix 复跑同一份)
// V2 Step 27.5.2 — 扩 variant:postfix-ext(库外 20 题)/ postfix-int(库内 44 题 + top1_sim)
//
// ════════════════════════════════════════════════════════════════════════════════
// ★ 铁律 1:本脚本控制流与 lib/agent/graph.ts 同构非同源
//
// 范式抄 scripts/agent/agentic-rag.ts:脚本内 embed-core 纯函数 + 自建 admin client +
// 复刻 graph 控制流外壳(callModel 手动 stream+concat 聚合 / ToolNode / shouldContinue
// 双判 AIMessage||AIMessageChunk / recursionLimit=10)绕开 server-only 链(tools.ts
// 顶部 import 拉 embed.ts / admin.ts 走 'server-only',tsx 不能加载)。
//
// 但下列三样 import 生产本尊焊死,绝不复刻:
//   - SYSTEM_PROMPT  ← lib/agent/prompt.ts(Step 27.5.1 抽出)
//   - isRefusalText / REFUSAL_PATTERN_A / _B  ← lib/agent/refusal.ts(Step 27.5.1 抽出)
//   - 检索口径(rerank-core + 同一 RPC match_document_chunks + 相同 K/MIN_SIMILARITY/
//     RERANK_TIMEOUT_MS/RERANK_MODEL)
//
// → 改 graph.ts 控制流(callModel/shouldContinue/recursionLimit/ToolNode 配置)必须
//   同步本脚本;27.5.2 改 prompt 只改 lib/agent/prompt.ts,本脚本零改动。
//
// ★ 铁律 2:27.5.2 改 prompt 只写通用约束(零命中/超知识库范围一律拒答),
// 禁止针对测试集具体题面定制措辞(如看到"Go 快排"漏拒就写"不准写 Go 代码")。
// 防过拟合 = 改后能泛化到未见过的库外问题,不只是过 testset。
// ════════════════════════════════════════════════════════════════════════════════
//
// 跑法:
//   改 prompt 前(prefix baseline):
//     npx tsx --env-file=.env.local scripts/eval/run-refusal-eval.ts prefix
//   改 prompt 后(库外 20 题):
//     npx tsx --env-file=.env.local scripts/eval/run-refusal-eval.ts postfix-ext
//   改 prompt 后(库内 44 题 + top1_sim):
//     npx tsx --env-file=.env.local scripts/eval/run-refusal-eval.ts postfix-int
//
// 输出:eval/results/refusal-baseline-{prefix|postfix-ext|postfix-int}.json
//
// 测试集:
//   prefix / postfix-ext → eval/refusal-testset.jsonl(库外 20 + 库内对照 4;ext 模式过滤 int_control)
//   postfix-int          → eval/testset-final.jsonl(Step 22 全 44 题,转为 int_full 类别)

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  StateGraph,
  MessagesAnnotation,
  START,
  END,
} from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { z } from 'zod';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  embedTextsWithConfig,
  type EmbedConfig,
} from '../../lib/rag/embed-core';
import { rerankDocuments } from '../../lib/rag/rerank-core';
// ── 本尊焊死:三样 import 不复刻 ─────────────────────────────────────────────
import { SYSTEM_PROMPT } from '../../lib/agent/prompt';
import {
  isRefusalText,
  REFUSAL_PATTERN_A,
  REFUSAL_PATTERN_B,
} from '../../lib/agent/refusal';

// ── 检索口径常量(对齐 lib/agent/tools.ts 字节级)─────────────────────────────
const TENANT_ID = 'afcd94f9-8a2f-4d5e-b4f3-36dee5e8320e';
const RECALL_K = 20;
const FINAL_K = 5;
const RERANK_TIMEOUT_MS = 3000;
const MIN_SIMILARITY = 0.3;
const RERANK_MODEL = 'BAAI/bge-reranker-v2-m3';

type Category =
  | 'ext_code'
  | 'ext_general'
  | 'ext_misc'
  | 'int_control'
  | 'int_full';

interface TestCase {
  qid: string;
  question: string;
  category: Category;
  ground_truth_should_refuse: boolean;
  ground_truth_chapter?: string; // Step 22 testset 字段,int_full 可用
  question_type?: string;        // Step 22 testset 字段,int_full 可用
}

interface CaseResult extends TestCase {
  fullText: string;
  patternA: boolean;
  patternB: boolean;
  isRefusal: boolean;
  matches_ground_truth: boolean;
  elapsed_ms: number;
  top1_sim?: number | null;       // postfix-int 模式专用:每题前置 retrieve top-1 cosine
}

interface RpcRow {
  id: string;
  document_id: string;
  content: string;
  similarity: number;
  metadata: Record<string, unknown>;
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

// ── 复刻 lib/agent/tools.ts makeSearchKnowledgeBaseTool 控制流外壳 ─────────
function makeSearchTool(
  admin: SupabaseClient,
  embedConfig: EmbedConfig,
  rerankApiKey: string,
  rerankBaseURL: string,
) {
  return tool(
    async ({ query }: { query: string }): Promise<string> => {
      try {
        const vectors = await embedTextsWithConfig([query], embedConfig);
        const queryEmbedding = vectors[0];

        const { data, error } = await admin.rpc('match_document_chunks', {
          query_embedding: queryEmbedding,
          tenant_id: TENANT_ID,
          match_count: RECALL_K,
          min_similarity: MIN_SIMILARITY,
        });
        if (error) throw new Error(`向量检索失败:${error.message}`);

        const rows = (data ?? []) as RpcRow[];
        if (rows.length === 0) return '知识库中未找到与该问题相关的内容。';

        let finalRows: RpcRow[];
        try {
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(),
            RERANK_TIMEOUT_MS,
          );
          try {
            const reranked = await rerankDocuments({
              apiKey: rerankApiKey,
              baseURL: rerankBaseURL,
              model: RERANK_MODEL,
              query,
              documents: rows.map((r) => r.content),
              topN: FINAL_K,
              signal: controller.signal,
            });
            finalRows = reranked.map((rr) => rows[rr.index]);
          } finally {
            clearTimeout(timer);
          }
        } catch (err: unknown) {
          console.warn('[eval/search] rerank 降级 → 回退召回 pgvector top-5', {
            query,
            err: err instanceof Error ? err.message : err,
          });
          finalRows = rows.slice(0, FINAL_K);
        }

        return finalRows
          .map((r, i) => `[来源 ${i + 1}] ${r.content}`)
          .join('\n\n');
      } catch (err: unknown) {
        console.error('[eval/search] 失败(降级):', err);
        return '当前知识库检索暂时不可用,请稍后再试或换个表达方式。';
      }
    },
    {
      name: 'search_knowledge_base',
      description:
        '检索企业知识库,返回最相关的文档片段。当用户问题需要查阅知识库内容时调用。',
      schema: z.object({
        query: z.string().describe('要检索的问题或关键词'),
      }),
    },
  );
}

function makeListTool(admin: SupabaseClient) {
  return tool(
    async (): Promise<string> => {
      try {
        const { data, error } = await admin
          .from('documents')
          .select('id, title, status, chunk_count')
          .eq('user_id', TENANT_ID)
          .order('created_at', { ascending: false });
        if (error) throw new Error(`查询文档列表失败:${error.message}`);
        const rows = (data ?? []) as Array<{
          id: string;
          title: string;
          status: string;
          chunk_count: number | null;
        }>;
        if (rows.length === 0) return '当前知识库暂无文档。';
        const cn = (s: string) =>
          s === 'processing'
            ? '处理中'
            : s === 'ready'
              ? '就绪'
              : s === 'failed'
                ? '失败'
                : s;
        return rows
          .map((r) => `「${r.title}」— ${cn(r.status)} — ${r.chunk_count ?? 0} 块`)
          .join('\n');
      } catch (err) {
        console.error('[eval/list] 失败(降级):', err);
        return '当前无法获取知识库文档列表,请稍后再试。';
      }
    },
    {
      name: 'list_documents',
      description:
        '列出当前租户知识库内所有文档的标题、处理状态与块数。当用户询问"知识库有哪些文档/你都知道什么内容/有什么资料/文档清单"等元信息时调用;不要用于回答具体业务问题。',
      schema: z.object({}),
    },
  );
}

// escalate / feedback 评估场景下不应被触发,留 stub 让工具集对齐 SYSTEM_PROMPT 描述
function makeEscalateStub() {
  return tool(
    async ({ reason: _reason }: { reason: string }): Promise<string> => {
      console.warn('[eval/escalate] ⚠ stub 被触发');
      return '已为您记录转人工请求,工作人员会尽快与您联系。';
    },
    {
      name: 'escalate_to_human',
      description:
        '当用户明确要求转人工 / 投诉抱怨 / 多轮无法解决问题时调用,记录转人工请求并返回标准化文案。',
      schema: z.object({ reason: z.string().min(1).max(500) }),
    },
  );
}

function makeFeedbackStub() {
  return tool(
    async ({
      rating: _rating,
      comment: _comment,
    }: {
      rating: 'positive' | 'negative';
      comment?: string;
    }): Promise<string> => {
      console.warn('[eval/feedback] ⚠ stub 被触发');
      return '感谢您的反馈,我们会持续改进。';
    },
    {
      name: 'record_user_feedback',
      description:
        '当用户主动对前一轮回答表达满意或不满时调用。不要主动索取反馈、不要每轮都调。',
      schema: z.object({
        rating: z.enum(['positive', 'negative']),
        comment: z.string().max(1000).optional(),
      }),
    },
  );
}

// ── 复刻 lib/agent/graph.ts 控制流外壳 ────────────────────────────────────
function buildGraph(
  admin: SupabaseClient,
  embedConfig: EmbedConfig,
  siliconKey: string,
  siliconBase: string,
) {
  const tools = [
    makeSearchTool(admin, embedConfig, siliconKey, siliconBase),
    makeListTool(admin),
    makeEscalateStub(),
    makeFeedbackStub(),
  ];

  // 坑 1:绝不设 streaming: true(对齐 graph.ts:76-81)
  const llm = new ChatOpenAI({
    model: 'deepseek-ai/DeepSeek-V3',
    apiKey: siliconKey,
    configuration: { baseURL: siliconBase },
  }).bindTools(tools);

  async function callModel(state: typeof MessagesAnnotation.State) {
    // 坑 1:手动 stream+concat 聚合(对齐 graph.ts:83-96)
    const stream = await llm.stream(state.messages);
    let aggregated: AIMessageChunk | undefined;
    for await (const chunk of stream) {
      aggregated = aggregated
        ? (aggregated.concat(chunk) as AIMessageChunk)
        : chunk;
    }
    if (!aggregated) throw new Error('LLM 没有输出 chunks');
    return { messages: [aggregated] };
  }

  function shouldContinue(state: typeof MessagesAnnotation.State) {
    const last = state.messages.at(-1);
    // 坑 2:|| 双判 AIMessage || AIMessageChunk(对齐 graph.ts:98-108)
    if (
      (last instanceof AIMessage || last instanceof AIMessageChunk) &&
      (last.tool_calls?.length ?? 0) > 0
    ) {
      return 'tools';
    }
    return END;
  }

  return new StateGraph(MessagesAnnotation)
    .addNode('agent', callModel)
    .addNode('tools', new ToolNode(tools, { handleToolErrors: true }))
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue)
    .addEdge('tools', 'agent')
    .compile();
}

async function runOne(
  graph: ReturnType<typeof buildGraph>,
  c: TestCase,
): Promise<CaseResult> {
  const messages: BaseMessage[] = [
    new SystemMessage(SYSTEM_PROMPT), // 本尊焊死
    new HumanMessage(c.question),
  ];

  const t0 = Date.now();
  let fullText = '';
  for await (const chunk of await graph.stream(
    { messages },
    { streamMode: 'messages', recursionLimit: 10 },
  )) {
    if (!Array.isArray(chunk) || chunk.length < 2) continue;
    const [msg, metadata] = chunk;
    const node = isRecord(metadata) ? metadata.langgraph_node : undefined;
    if (node !== 'agent') continue;
    if (!(msg instanceof AIMessageChunk)) continue;
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (!text) continue;
    fullText += text;
  }
  const elapsed = Date.now() - t0;

  const patternA = REFUSAL_PATTERN_A.test(fullText);
  const patternB = REFUSAL_PATTERN_B.test(fullText);
  const refusal = isRefusalText(fullText);

  return {
    ...c,
    fullText,
    patternA,
    patternB,
    isRefusal: refusal,
    matches_ground_truth: refusal === c.ground_truth_should_refuse,
    elapsed_ms: elapsed,
  };
}

async function loadTestset(filePath: string): Promise<TestCase[]> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const cases: TestCase[] = [];
  for (const line of lines) {
    const obj = JSON.parse(line) as TestCase;
    cases.push(obj);
  }
  return cases;
}

// Step 22 测试集 schema(Step 27.5.2 postfix-int 复用):
// {id, question, question_type, ground_truth_chapter, secondary_chapters, source_chunk_preview}
// 转成本脚本 TestCase 格式,category=int_full,ground_truth_should_refuse=false(库内本就不该拒)
interface Step22TestCase {
  id: string;
  question: string;
  question_type?: string;
  ground_truth_chapter?: string;
}
async function loadInternalFullTestset(filePath: string): Promise<TestCase[]> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const cases: TestCase[] = [];
  for (const line of lines) {
    const obj = JSON.parse(line) as Step22TestCase;
    cases.push({
      qid: obj.id,
      question: obj.question,
      category: 'int_full',
      ground_truth_should_refuse: false,
      question_type: obj.question_type,
      ground_truth_chapter: obj.ground_truth_chapter,
    });
  }
  return cases;
}

// 取该题 pgvector top-1 cosine 相似度(MIN_SIMILARITY=0 不过滤,真 top-1)。
// 仅 postfix-int 模式用,目的是诊断"库内误拒是否集中在中等偏低相似度区间"。
// 与生产 search 不同:这里 K=1 / MIN_SIM=0,纯粹拿排第一的余弦相似度,不参与 Agent 决策。
async function retrieveTop1Sim(
  admin: SupabaseClient,
  embedConfig: EmbedConfig,
  query: string,
): Promise<number | null> {
  try {
    const vectors = await embedTextsWithConfig([query], embedConfig);
    const { data, error } = await admin.rpc('match_document_chunks', {
      query_embedding: vectors[0],
      tenant_id: TENANT_ID,
      match_count: 1,
      min_similarity: 0,
    });
    if (error) {
      console.warn('[eval/top1-sim] RPC 失败:', error.message);
      return null;
    }
    const rows = (data ?? []) as RpcRow[];
    return rows[0]?.similarity ?? null;
  } catch (err) {
    console.warn('[eval/top1-sim] 取 top-1 sim 失败(降级 null):', err);
    return null;
  }
}

interface CategorySummary {
  total: number;
  refused: number;
  refusal_rate: string;
  matches_gt: number;
  match_rate: string;
}

interface ExtSummary {
  total: number;
  refused: number;
  refusal_rate: string;
  code: CategorySummary;
  general: CategorySummary;
  misc: CategorySummary;
}

interface IntControlSummary {
  total: number;
  false_refused: number;
  false_refusal_rate: string;
}

interface IntFullSummary {
  total: number;
  false_refused: number;
  false_refusal_rate: string;
  // postfix-int 专用:误拒清单(qid / question / top1_sim / chapter)
  false_refusal_cases: Array<{
    qid: string;
    question: string;
    top1_sim: number | null;
    ground_truth_chapter?: string;
    question_type?: string;
    fullText: string;
  }>;
  // 全 44 题的 top-1 sim 分布(诊断"误拒是否集中在中等偏低相似度")
  top1_sim_distribution: {
    min: number | null;
    p25: number | null;
    p50: number | null;
    p75: number | null;
    max: number | null;
  };
}

interface Summary {
  total: number;
  ext?: ExtSummary;
  int_control?: IntControlSummary;
  int_full?: IntFullSummary;
}

function byCategorySummary(results: CaseResult[], cat: Category): CategorySummary {
  const sub = results.filter((r) => r.category === cat);
  const refused = sub.filter((r) => r.isRefusal).length;
  const matches = sub.filter((r) => r.matches_ground_truth).length;
  return {
    total: sub.length,
    refused,
    refusal_rate: sub.length === 0 ? '0/0' : `${refused}/${sub.length}`,
    matches_gt: matches,
    match_rate: sub.length === 0 ? '0/0' : `${matches}/${sub.length}`,
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function summarize(results: CaseResult[]): Summary {
  const out: Summary = { total: results.length };

  const ext = results.filter((r) =>
    ['ext_code', 'ext_general', 'ext_misc'].includes(r.category),
  );
  if (ext.length > 0) {
    const extRefused = ext.filter((r) => r.isRefusal).length;
    out.ext = {
      total: ext.length,
      refused: extRefused,
      refusal_rate: `${extRefused}/${ext.length}`,
      code: byCategorySummary(results, 'ext_code'),
      general: byCategorySummary(results, 'ext_general'),
      misc: byCategorySummary(results, 'ext_misc'),
    };
  }

  const intControl = results.filter((r) => r.category === 'int_control');
  if (intControl.length > 0) {
    const intFalseRefused = intControl.filter((r) => r.isRefusal).length;
    out.int_control = {
      total: intControl.length,
      false_refused: intFalseRefused,
      false_refusal_rate: `${intFalseRefused}/${intControl.length}`,
    };
  }

  const intFull = results.filter((r) => r.category === 'int_full');
  if (intFull.length > 0) {
    const intFalseRefused = intFull.filter((r) => r.isRefusal).length;
    const sims = intFull
      .map((r) => r.top1_sim)
      .filter((v): v is number => typeof v === 'number')
      .sort((a, b) => a - b);
    out.int_full = {
      total: intFull.length,
      false_refused: intFalseRefused,
      false_refusal_rate: `${intFalseRefused}/${intFull.length}`,
      false_refusal_cases: intFull
        .filter((r) => r.isRefusal)
        .map((r) => ({
          qid: r.qid,
          question: r.question,
          top1_sim: r.top1_sim ?? null,
          ground_truth_chapter: r.ground_truth_chapter,
          question_type: r.question_type,
          fullText: r.fullText,
        })),
      top1_sim_distribution: {
        min: sims[0] ?? null,
        p25: percentile(sims, 0.25),
        p50: percentile(sims, 0.5),
        p75: percentile(sims, 0.75),
        max: sims[sims.length - 1] ?? null,
      },
    };
  }

  return out;
}

type Variant = 'prefix' | 'postfix-ext' | 'postfix-int';

async function main(): Promise<void> {
  const variant = (process.argv[2] ?? '').trim() as Variant;
  const validVariants: Variant[] = ['prefix', 'postfix-ext', 'postfix-int'];
  if (!validVariants.includes(variant)) {
    console.error(
      '[失败] 用法:npx tsx ... run-refusal-eval.ts <prefix|postfix-ext|postfix-int>',
    );
    process.exit(1);
  }

  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const siliconKey = requireEnv('SILICONFLOW_API_KEY');
  const siliconBase = requireEnv('SILICONFLOW_BASE_URL');

  const repoRoot = path.resolve(__dirname, '../..');
  const resultsDir = path.join(repoRoot, 'eval', 'results');
  const resultsPath = path.join(
    resultsDir,
    `refusal-baseline-${variant}.json`,
  );

  // 按 variant 选 testset + 过滤
  let testsetPath: string;
  let cases: TestCase[];
  if (variant === 'postfix-int') {
    testsetPath = path.join(repoRoot, 'eval', 'testset-final.jsonl');
    cases = await loadInternalFullTestset(testsetPath);
  } else {
    testsetPath = path.join(repoRoot, 'eval', 'refusal-testset.jsonl');
    const all = await loadTestset(testsetPath);
    cases =
      variant === 'postfix-ext'
        ? all.filter((c) => c.category !== 'int_control') // 库外 20
        : all; // prefix 跑全 24
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const embedConfig: EmbedConfig = { apiKey: siliconKey, baseURL: siliconBase };
  const graph = buildGraph(admin, embedConfig, siliconKey, siliconBase);

  console.log('═'.repeat(78));
  console.log(`V2 Step 27.5.x — 拒答评估(${variant})`);
  console.log('═'.repeat(78));
  console.log(`TENANT_ID = ${TENANT_ID}`);
  console.log(
    `SYSTEM_PROMPT 字节数 = ${SYSTEM_PROMPT.length}(从 lib/agent/prompt.ts 本尊 import)`,
  );
  console.log(`PATTERN_A = ${REFUSAL_PATTERN_A}`);
  console.log(`PATTERN_B = ${REFUSAL_PATTERN_B}`);
  console.log(`测试集: ${testsetPath}(${cases.length} 题)`);
  console.log(`输出:   ${resultsPath}`);

  const results: CaseResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    console.log(`\n${'─'.repeat(78)}`);
    console.log(`[${i + 1}/${cases.length}] ${c.qid} (${c.category})`);
    console.log(`  question: ${c.question}`);
    console.log(
      `  ground_truth_should_refuse: ${c.ground_truth_should_refuse}`,
    );

    // postfix-int 模式:每题前置 retrieve top-1 cosine(MIN_SIM=0,真 top-1)
    let top1Sim: number | null | undefined;
    if (variant === 'postfix-int') {
      top1Sim = await retrieveTop1Sim(admin, embedConfig, c.question);
      console.log(
        `  top1_sim (pgvector cosine, K=1, MIN_SIM=0): ${top1Sim === null ? 'null' : top1Sim.toFixed(4)}`,
      );
    }

    const r = await runOne(graph, c);
    if (variant === 'postfix-int') r.top1_sim = top1Sim ?? null;
    results.push(r);

    const preview =
      r.fullText.length > 240
        ? `${r.fullText.slice(0, 240)}…(${r.fullText.length}字)`
        : r.fullText;
    console.log(`  fullText: ${preview.replace(/\n/g, ' ⏎ ')}`);
    console.log(
      `  A=${r.patternA ? '✓' : '✗'} B=${r.patternB ? '✓' : '✗'} isRefusal=${r.isRefusal} matches_gt=${r.matches_ground_truth ? '✓' : '✗'} elapsed=${r.elapsed_ms}ms`,
    );
  }

  const summary = summarize(results);

  console.log(`\n${'═'.repeat(78)}`);
  console.log(`★ ${cases.length} 题完整结果表`);
  console.log('═'.repeat(78));
  if (variant === 'postfix-int') {
    console.log(
      `${'qid'.padEnd(8)} ${'top1_sim'.padEnd(10)} ${'isRefusal'.padEnd(10)} ${'chapter'.padEnd(16)} question`,
    );
    for (const r of results) {
      const sim =
        typeof r.top1_sim === 'number' ? r.top1_sim.toFixed(4) : 'null';
      console.log(
        `${r.qid.padEnd(8)} ${sim.padEnd(10)} ${String(r.isRefusal).padEnd(10)} ${(r.ground_truth_chapter ?? '').padEnd(16)} ${r.question}`,
      );
    }
  } else {
    console.log(
      `${'qid'.padEnd(14)} ${'category'.padEnd(13)} ${'gt_refuse'.padEnd(10)} ${'isRefusal'.padEnd(10)} ${'matches_gt'.padEnd(11)} question`,
    );
    for (const r of results) {
      console.log(
        `${r.qid.padEnd(14)} ${r.category.padEnd(13)} ${String(r.ground_truth_should_refuse).padEnd(10)} ${String(r.isRefusal).padEnd(10)} ${(r.matches_ground_truth ? '✓' : '✗').padEnd(11)} ${r.question}`,
      );
    }
  }

  console.log(`\n${'═'.repeat(78)}`);
  console.log('★ 汇总');
  console.log('═'.repeat(78));

  if (summary.ext) {
    console.log(`库外(${summary.ext.total} 题,期望拒答):`);
    console.log(`  整体拒答率: ${summary.ext.refusal_rate}`);
    console.log(`    · 编程(ext_code):   ${summary.ext.code.refusal_rate}`);
    console.log(`    · 通用(ext_general):${summary.ext.general.refusal_rate}`);
    console.log(`    · 业务(ext_misc):   ${summary.ext.misc.refusal_rate}`);
  }
  if (summary.int_control) {
    console.log(`库内对照(${summary.int_control.total} 题,期望不拒答):`);
    console.log(`  误拒率: ${summary.int_control.false_refusal_rate}`);
  }
  if (summary.int_full) {
    const f = summary.int_full;
    console.log(`库内全集(${f.total} 题,期望不拒答):`);
    console.log(`  误拒率: ${f.false_refusal_rate}`);
    console.log(
      `  top1_sim 分布: min=${f.top1_sim_distribution.min?.toFixed(4) ?? 'null'} p25=${f.top1_sim_distribution.p25?.toFixed(4) ?? 'null'} p50=${f.top1_sim_distribution.p50?.toFixed(4) ?? 'null'} p75=${f.top1_sim_distribution.p75?.toFixed(4) ?? 'null'} max=${f.top1_sim_distribution.max?.toFixed(4) ?? 'null'}`,
    );
    if (f.false_refusal_cases.length > 0) {
      console.log('  误拒清单:');
      for (const c of f.false_refusal_cases) {
        const sim =
          typeof c.top1_sim === 'number' ? c.top1_sim.toFixed(4) : 'null';
        console.log(
          `    [${c.qid}] top1_sim=${sim} chapter=${c.ground_truth_chapter ?? '-'} type=${c.question_type ?? '-'}`,
        );
        console.log(`      Q: ${c.question}`);
        console.log(
          `      A: ${c.fullText.slice(0, 200).replace(/\n/g, ' ⏎ ')}${c.fullText.length > 200 ? '…' : ''}`,
        );
      }
    } else {
      console.log('  无误拒(库内全 44 题 isRefusal 全为 false)');
    }
  }

  await fs.mkdir(resultsDir, { recursive: true });
  const stepLabel =
    variant === 'prefix' ? '27.5.1' : variant === 'postfix-ext' ? '27.5.2' : '27.5.2';
  const payload = {
    ts: new Date().toISOString(),
    step: `${stepLabel}-${variant}-baseline`,
    tenant_id: TENANT_ID,
    system_prompt_bytes: SYSTEM_PROMPT.length,
    pattern_a: String(REFUSAL_PATTERN_A),
    pattern_b: String(REFUSAL_PATTERN_B),
    testset_path: path.relative(repoRoot, testsetPath).replace(/\\/g, '/'),
    total: results.length,
    summary,
    results,
  };
  await fs.writeFile(resultsPath, JSON.stringify(payload, null, 2), 'utf-8');

  console.log(`\n结果已写入: ${resultsPath}`);
  console.log('═'.repeat(78));
}

main().catch((err) => {
  console.error('[失败]', err);
  process.exit(1);
});
