// V2 Step 22 — 只读体检脚本:抽样查看账号 A 知识库,判断是否可清空重置
//
// ⚠️ 严禁写库:本文件不出现 .insert / .update / .delete / .upsert / .rpc
//    任何写操作都是 bug
//
// 注意:tsx 脚本环境,不能加 'server-only'(EXPERIENCE 主题 1.2)

import { createClient } from '@supabase/supabase-js';

// 测试账号 A(见 HANDOFF 第四节)
const TENANT_ID = 'afcd94f9-8a2f-4d5e-b4f3-36dee5e8320e';
const SAMPLE_CHUNK_COUNT = 8;
const SAMPLE_PREVIEW_CHARS = 150;

interface DocumentRow {
  id: string;
  title: string;
  content_type: 'pdf' | 'txt' | 'url' | 'docx';
  status: 'processing' | 'ready' | 'failed';
  chunk_count: number | null;
  created_at: string;
}

interface ChunkRow {
  document_id: string;
  content: string;
}

interface SessionRow {
  id: string;
  visitor_id: string;
  created_at: string;
}

interface MessageRow {
  session_id: string;
  role: 'user' | 'assistant' | 'system';
}

function divider(): void {
  console.log('─'.repeat(60));
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('[失败] 缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const admin = createClient(url, key, { auth: { persistSession: false } });

  console.log('只读体检账号 A 知识库');
  console.log(`TENANT_ID = ${TENANT_ID}`);

  // ────────────────────────────────────────────────────────────
  // ① documents — READ-ONLY
  // ────────────────────────────────────────────────────────────
  divider();
  console.log('① documents');
  divider();
  const docRes = await admin
    .from('documents')
    .select('id, title, content_type, status, chunk_count, created_at')
    .eq('user_id', TENANT_ID)
    .order('created_at', { ascending: true })
    .returns<DocumentRow[]>();
  if (docRes.error) {
    console.error('[失败] documents 查询出错', docRes.error);
    process.exit(1);
  }
  const documents: DocumentRow[] = docRes.data ?? [];

  if (documents.length === 0) {
    console.log('(账号 A 没有任何文档)');
  } else {
    console.log(
      [
        '短ID'.padEnd(8),
        'type'.padEnd(5),
        'status'.padEnd(10),
        'chunk'.padEnd(6),
        'created_at'.padEnd(26),
        'title',
      ].join('  '),
    );
    for (const d of documents) {
      console.log(
        [
          shortId(d.id).padEnd(8),
          (d.content_type ?? '?').padEnd(5),
          (d.status ?? '?').padEnd(10),
          String(d.chunk_count ?? 0).padEnd(6),
          d.created_at.padEnd(26),
          d.title,
        ].join('  '),
      );
    }
    console.log(`\n文档总数:${documents.length}`);
  }

  // ────────────────────────────────────────────────────────────
  // ② document_chunks 全量统计 — READ-ONLY
  // ────────────────────────────────────────────────────────────
  divider();
  console.log('② document_chunks 统计');
  divider();
  const chunkRes = await admin
    .from('document_chunks')
    .select('document_id, content')
    .eq('user_id', TENANT_ID)
    .order('created_at', { ascending: true })
    .returns<ChunkRow[]>();
  if (chunkRes.error) {
    console.error('[失败] document_chunks 查询出错', chunkRes.error);
    process.exit(1);
  }
  const chunks: ChunkRow[] = chunkRes.data ?? [];
  const totalChunks = chunks.length;

  console.log(`总 chunk 数:${totalChunks}`);
  if (totalChunks > 0) {
    const lengths = chunks.map((c) => c.content.length);
    const min = lengths.reduce((a, b) => Math.min(a, b), lengths[0]);
    const max = lengths.reduce((a, b) => Math.max(a, b), lengths[0]);
    const sum = lengths.reduce((a, b) => a + b, 0);
    const avg = Math.round(sum / lengths.length);
    console.log(`长度分布:min=${min} / max=${max} / avg=${avg}`);

    const countByDoc = new Map<string, number>();
    for (const c of chunks) {
      countByDoc.set(c.document_id, (countByDoc.get(c.document_id) ?? 0) + 1);
    }

    if (documents.length > 0) {
      console.log('\n各文档贡献 chunk 数(② 实算 vs ① documents.chunk_count 缓存):');
      for (const d of documents) {
        const actual = countByDoc.get(d.id) ?? 0;
        const cached = d.chunk_count ?? 0;
        const mark = actual === cached ? '' : '  ⚠️ 不一致';
        console.log(
          `  ${shortId(d.id)}  实算=${String(actual).padStart(4)}  缓存=${String(cached).padStart(4)}${mark}  ${d.title}`,
        );
      }
    }

    const docIds = new Set(documents.map((d) => d.id));
    const orphanCount = chunks.filter((c) => !docIds.has(c.document_id)).length;
    if (orphanCount > 0) {
      console.log(`\n⚠️ 孤儿 chunk(document_id 不在 documents 表):${orphanCount}`);
    }
  }

  // ────────────────────────────────────────────────────────────
  // ③ chat_sessions 统计 — READ-ONLY
  // ────────────────────────────────────────────────────────────
  divider();
  console.log('③ chat_sessions 统计');
  divider();
  const sessRes = await admin
    .from('chat_sessions')
    .select('id, visitor_id, created_at')
    .eq('user_id', TENANT_ID)
    .order('created_at', { ascending: true })
    .returns<SessionRow[]>();
  if (sessRes.error) {
    console.error('[失败] chat_sessions 查询出错', sessRes.error);
    process.exit(1);
  }
  const sessions: SessionRow[] = sessRes.data ?? [];

  console.log(`session 总数:${sessions.length}`);
  if (sessions.length > 0) {
    const uniqueVisitors = new Set(sessions.map((s) => s.visitor_id)).size;
    console.log(`唯一 visitor 数:${uniqueVisitors}`);
    console.log(`最早 session:${sessions[0].created_at}`);
    console.log(`最晚 session:${sessions[sessions.length - 1].created_at}`);
  }

  // ────────────────────────────────────────────────────────────
  // ④ chat_messages 统计
  // chat_messages 无 user_id 列,只能用 ③ 取出的服务端权威 session_ids
  // 间接关联(EXPERIENCE 主题 6.2);session_ids 不来自前端,安全
  // READ-ONLY
  // ────────────────────────────────────────────────────────────
  divider();
  console.log('④ chat_messages 统计');
  divider();
  if (sessions.length === 0) {
    console.log('(账号 A 无 session,无消息可统计)');
  } else {
    const sessionIds = sessions.map((s) => s.id);
    const msgRes = await admin
      .from('chat_messages')
      .select('session_id, role')
      .in('session_id', sessionIds)
      .returns<MessageRow[]>();
    if (msgRes.error) {
      console.error('[失败] chat_messages 查询出错', msgRes.error);
      process.exit(1);
    }
    const messages: MessageRow[] = msgRes.data ?? [];
    console.log(`消息总数:${messages.length}`);

    if (messages.length > 0) {
      const roleCount = new Map<string, number>();
      for (const m of messages) {
        roleCount.set(m.role, (roleCount.get(m.role) ?? 0) + 1);
      }
      console.log('role 分布:');
      for (const [role, n] of roleCount.entries()) {
        console.log(`  ${role.padEnd(10)} ${n}`);
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // ⑤ 均衡抽样 chunks — READ-ONLY
  // 策略:每篇文档至少抽 1 个;round-robin 多轮,凑够 SAMPLE_CHUNK_COUNT
  //  - 文档数 ≥ 8:每篇 1 个,取前 8 篇
  //  - 文档数 < 8:循环遍历每篇取 1 个,直到凑够 8 或所有桶取尽
  // ────────────────────────────────────────────────────────────
  divider();
  console.log(`⑤ 均衡抽样 chunks(目标 ${SAMPLE_CHUNK_COUNT} 个)`);
  divider();

  if (totalChunks === 0 || documents.length === 0) {
    console.log('(无 chunk 可抽)');
  } else {
    const bucketsByDoc = new Map<string, ChunkRow[]>();
    for (const d of documents) bucketsByDoc.set(d.id, []);
    for (const c of chunks) {
      const bucket = bucketsByDoc.get(c.document_id);
      if (bucket) bucket.push(c);
    }

    interface SampledChunk {
      docId: string;
      title: string;
      content: string;
    }
    const sampled: SampledChunk[] = [];
    let madeProgress = true;
    while (sampled.length < SAMPLE_CHUNK_COUNT && madeProgress) {
      madeProgress = false;
      for (const d of documents) {
        if (sampled.length >= SAMPLE_CHUNK_COUNT) break;
        const bucket = bucketsByDoc.get(d.id);
        if (bucket && bucket.length > 0) {
          const c = bucket.shift();
          if (c) {
            sampled.push({ docId: d.id, title: d.title, content: c.content });
            madeProgress = true;
          }
        }
      }
    }

    if (sampled.length === 0) {
      console.log('(无 chunk 可抽)');
    } else {
      sampled.forEach((s, idx) => {
        const preview = s.content.slice(0, SAMPLE_PREVIEW_CHARS).replace(/\s+/g, ' ');
        console.log(
          `\n[${String(idx + 1).padStart(2)}] 来自《${s.title}》(${shortId(s.docId)}) | length=${s.content.length}`,
        );
        console.log(`     ${preview}`);
      });
      console.log(`\n共抽样 ${sampled.length} 个 chunk`);
    }
  }

  divider();
  console.log(
    `✅ 只读体检完成。共扫描 ${documents.length} 文档 / ${totalChunks} chunks / ${sessions.length} sessions,无任何写操作。`,
  );
}

main().catch((err) => {
  console.error('[失败]', err);
  process.exit(1);
});
