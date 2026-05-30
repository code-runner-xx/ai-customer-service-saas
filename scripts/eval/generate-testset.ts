// V2 Step 22 阶段 2a — 自动生成评估测试集
//
// ⚠️ 严禁写数据库:本文件不出现 .insert / .update / .delete / .upsert / .rpc
//    只读 document_chunks,只写本地 eval/testset.jsonl
//
// 注意:tsx 脚本环境,不能加 'server-only'(EXPERIENCE 主题 1.2)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';

// 测试账号 A(见 HANDOFF 第四节)
const TENANT_ID = 'afcd94f9-8a2f-4d5e-b4f3-36dee5e8320e';
const MODEL = 'deepseek-ai/DeepSeek-V3';
const OUTPUT_PATH = 'eval/testset.jsonl';
const PREVIEW_CHARS = 50;
const TEMPERATURE = 0.5;

interface ChunkRow {
  id: string;
  content: string;
}

interface GeneratedQuestion {
  question: string;
  type: 'fact' | 'colloquial';
}

interface TestsetEntry {
  id: string;
  question: string;
  ground_truth_chunk_id: string;
  question_type: 'fact' | 'colloquial';
  source_chunk_preview: string;
}

const SYSTEM_PROMPT = `你是一个评估测试集生成器。你的任务是基于一段客服知识库内容,模拟真实用户会向客服提出的问题。

严格规则:
1. 生成 3-4 个问题,每个问题的答案必须明确出现在给定内容里。
2. 至少 1 个问题用口语化、换词表达(不照搬原文措辞),标 type="colloquial";其余用正式问法,标 type="fact"。
3. 禁止生成元问题(如"这段讲了什么"、"这部分内容是关于什么的")。
4. 禁止生成需要跨多段才能回答的问题。
5. 模拟终端用户视角(消费者/客户),不要从"知识库管理员"角度提问。
6. 只输出 JSON 数组,不要 markdown 代码块包裹,不要任何解释文字。
   格式:[{"question": "...", "type": "fact"}, {"question": "...", "type": "colloquial"}]`;

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

// JSON 容错:三级降级
// 1) 整段直接 parse
// 2) markdown 代码块 ```json ... ``` 提取
// 3) 抓首个 [ ... ] 数组(防 LLM 加前后解说)
function extractJsonArray(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // 降级到下一级
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // 降级
    }
  }
  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch {
      // 落到底
    }
  }
  throw new Error('无法从 LLM 返回中提取 JSON 数组');
}

function normalizeQuestions(parsed: unknown, chunkId: string): GeneratedQuestion[] {
  if (!Array.isArray(parsed)) {
    throw new Error('LLM 返回不是 JSON 数组');
  }
  const out: GeneratedQuestion[] = [];
  parsed.forEach((item, idx) => {
    if (!isRecord(item)) {
      console.warn(`  ⚠️ chunk ${shortId(chunkId)} 第 ${idx + 1} 项不是对象,跳过`);
      return;
    }
    const q = item.question;
    if (typeof q !== 'string' || q.trim().length === 0) {
      console.warn(
        `  ⚠️ chunk ${shortId(chunkId)} 第 ${idx + 1} 项 question 缺失或非字符串,跳过`,
      );
      return;
    }
    let t: 'fact' | 'colloquial';
    const rawType = item.type;
    if (rawType === 'fact' || rawType === 'colloquial') {
      t = rawType;
    } else {
      console.warn(
        `  ⚠️ chunk ${shortId(chunkId)} 第 ${idx + 1} 项 type 异常(${String(rawType)}),默认 fact`,
      );
      t = 'fact';
    }
    out.push({ question: q.trim(), type: t });
  });
  return out;
}

// LangChain BaseMessage.content 在 1.x 是 string | MessageContentComplex[]
// 这里只取文本部分拼接,够用于本脚本场景
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

  console.log('V2 Step 22 阶段 2a — 生成评估测试集');
  console.log(`TENANT_ID = ${TENANT_ID}`);
  console.log(`MODEL = ${MODEL}  temperature = ${TEMPERATURE}\n`);

  // READ-ONLY:取账号 A 所有 chunk
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
    console.error('[失败] 账号 A 没有任何 chunk,无法生成测试集');
    process.exit(1);
  }
  console.log(`扫描到 ${chunks.length} 个 chunk,逐个生成题目(串行)...\n`);

  const entries: TestsetEntry[] = [];
  const failures: string[] = [];

  for (const [i, c] of chunks.entries()) {
    const tag = `[${i + 1}/${chunks.length}] chunk ${shortId(c.id)}`;
    try {
      const res = await llm.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(
          `基于以下客服知识库内容生成问题:\n\n<内容>\n${c.content}\n</内容>`,
        ),
      ]);
      const raw = getMessageContentAsString(res.content);
      const parsed = extractJsonArray(raw);
      const questions = normalizeQuestions(parsed, c.id);
      if (questions.length === 0) {
        console.warn(`${tag} → 0 题(LLM 返回的项全部不合规范),跳过`);
        failures.push(c.id);
        continue;
      }
      for (const q of questions) {
        entries.push({
          id: '',
          question: q.question,
          ground_truth_chunk_id: c.id,
          question_type: q.type,
          source_chunk_preview: c.content.slice(0, PREVIEW_CHARS),
        });
      }
      console.log(`${tag} → 生成 ${questions.length} 题`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} → ❌ 处理失败:${msg}`);
      failures.push(c.id);
    }
  }

  // 顺序编号 q001 / q002 ...
  entries.forEach((e, idx) => {
    e.id = `q${String(idx + 1).padStart(3, '0')}`;
  });

  // 写盘
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const jsonl =
    entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
  fs.writeFileSync(OUTPUT_PATH, jsonl, 'utf8');

  // 总结
  const factCount = entries.filter((e) => e.question_type === 'fact').length;
  const colloquialCount = entries.filter((e) => e.question_type === 'colloquial').length;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(
    `✅ 完成。共扫描 ${chunks.length} chunks,生成 ${entries.length} 题(fact: ${factCount} / colloquial: ${colloquialCount})`,
  );
  console.log(`写入:${OUTPUT_PATH}`);
  if (failures.length > 0) {
    console.log(`失败 chunks(已跳过,共 ${failures.length}):`);
    for (const id of failures) console.log(`  ${id}`);
  } else {
    console.log('失败 chunks:无');
  }
}

main().catch((err) => {
  console.error('[失败]', err);
  process.exit(1);
});
