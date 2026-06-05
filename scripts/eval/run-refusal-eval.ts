// V2 Step 27.5.1 — 拒答行为评估脚本(prefix baseline / postfix 复跑同一份)
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
//   改 prompt 后(postfix):
//     npx tsx --env-file=.env.local scripts/eval/run-refusal-eval.ts postfix
//
// 输出:eval/results/refusal-baseline-{prefix|postfix}.json
//
// 测试集:eval/refusal-testset.jsonl(24 题:库外 20 + 库内对照 4)

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

type Category = 'ext_code' | 'ext_general' | 'ext_misc' | 'int_control';

interface TestCase {
  qid: string;
  question: string;
  category: Category;
  ground_truth_should_refuse: boolean;
}

interface CaseResult extends TestCase {
  fullText: string;
  patternA: boolean;
  patternB: boolean;
  isRefusal: boolean;
  matches_ground_truth: boolean;
  elapsed_ms: number;
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

interface CategorySummary {
  total: number;
  refused: number;
  refusal_rate: string;
  matches_gt: number;
  match_rate: string;
}

interface Summary {
  total: number;
  ext: {
    total: number;
    refused: number;
    refusal_rate: string;
    code: CategorySummary;
    general: CategorySummary;
    misc: CategorySummary;
  };
  int: {
    total: number;
    false_refused: number;
    false_refusal_rate: string;
  };
}

function summarize(results: CaseResult[]): Summary {
  const byCategory = (cat: Category): CategorySummary => {
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
  };

  const code = byCategory('ext_code');
  const general = byCategory('ext_general');
  const misc = byCategory('ext_misc');
  const ext = results.filter((r) => r.category !== 'int_control');
  const extRefused = ext.filter((r) => r.isRefusal).length;

  const intControl = results.filter((r) => r.category === 'int_control');
  const intFalseRefused = intControl.filter((r) => r.isRefusal).length;

  return {
    total: results.length,
    ext: {
      total: ext.length,
      refused: extRefused,
      refusal_rate: ext.length === 0 ? '0/0' : `${extRefused}/${ext.length}`,
      code,
      general,
      misc,
    },
    int: {
      total: intControl.length,
      false_refused: intFalseRefused,
      false_refusal_rate:
        intControl.length === 0
          ? '0/0'
          : `${intFalseRefused}/${intControl.length}`,
    },
  };
}

async function main(): Promise<void> {
  const variant = (process.argv[2] ?? 'prefix').trim();
  if (variant !== 'prefix' && variant !== 'postfix') {
    console.error('[失败] 用法:npx tsx ... run-refusal-eval.ts <prefix|postfix>');
    process.exit(1);
  }

  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const siliconKey = requireEnv('SILICONFLOW_API_KEY');
  const siliconBase = requireEnv('SILICONFLOW_BASE_URL');

  const repoRoot = path.resolve(__dirname, '../..');
  const testsetPath = path.join(repoRoot, 'eval', 'refusal-testset.jsonl');
  const resultsDir = path.join(repoRoot, 'eval', 'results');
  const resultsPath = path.join(
    resultsDir,
    `refusal-baseline-${variant}.json`,
  );

  const cases = await loadTestset(testsetPath);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const embedConfig: EmbedConfig = { apiKey: siliconKey, baseURL: siliconBase };
  const graph = buildGraph(admin, embedConfig, siliconKey, siliconBase);

  console.log('═'.repeat(78));
  console.log(`V2 Step 27.5.1 — 拒答评估(${variant} baseline)`);
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
    console.log(`  ground_truth_should_refuse: ${c.ground_truth_should_refuse}`);
    const r = await runOne(graph, c);
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
  console.log('★ 24 题完整结果表');
  console.log('═'.repeat(78));
  console.log(
    `${'qid'.padEnd(14)} ${'category'.padEnd(13)} ${'gt_refuse'.padEnd(10)} ${'isRefusal'.padEnd(10)} ${'matches_gt'.padEnd(11)} question`,
  );
  for (const r of results) {
    console.log(
      `${r.qid.padEnd(14)} ${r.category.padEnd(13)} ${String(r.ground_truth_should_refuse).padEnd(10)} ${String(r.isRefusal).padEnd(10)} ${(r.matches_ground_truth ? '✓' : '✗').padEnd(11)} ${r.question}`,
    );
  }

  console.log(`\n${'═'.repeat(78)}`);
  console.log('★ 汇总');
  console.log('═'.repeat(78));
  console.log(`库外(20 题,期望拒答):`);
  console.log(`  整体拒答率: ${summary.ext.refusal_rate}`);
  console.log(`    · 编程(ext_code):   ${summary.ext.code.refusal_rate}`);
  console.log(`    · 通用(ext_general):${summary.ext.general.refusal_rate}`);
  console.log(`    · 业务(ext_misc):   ${summary.ext.misc.refusal_rate}`);
  console.log(`库内(4 题,期望不拒答):`);
  console.log(
    `  误拒率: ${summary.int.false_refusal_rate}(应=0/4;非 0 立刻扩 Step 22 全 44 题复测)`,
  );

  await fs.mkdir(resultsDir, { recursive: true });
  const payload = {
    ts: new Date().toISOString(),
    step: `27.5.1-${variant}-baseline`,
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
