import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { chunkText } from "./chunk";
import { embedTexts } from "./embed";
import { CHUNK_INSERT_BATCH } from "@/lib/validators/ingest";

/**
 * 第二关卡:已建好 documents 行之后的"昂贵处理"。
 * 任何一步失败都把 documents 标记为 failed + error_message,并把错误往上抛。
 * 成功则更新 status='ready' + char_count + chunk_count。
 *
 * 规则:
 * - chunks 批量写入按 CHUNK_INSERT_BATCH(100)条一批,**串行**,任一批失败立即中止。
 * - 中止时会尽力回滚:删除已写入的 chunks(RLS 由 admin 绕过,但显式带 user_id/document_id)。
 * - 每行都显式写 user_id,遵守多租户隔离铁律。
 */
export async function processAndStoreDocument(params: {
  userId: string;
  documentId: string;
  text: string;
}): Promise<{ charCount: number; chunkCount: number }> {
  const { userId, documentId, text } = params;
  const admin = createAdminClient();

  try {
    const charCount = text.length;

    const chunks = await chunkText(text);
    if (chunks.length === 0) {
      throw new Error("切块结果为空,文档可能过短或内容无效");
    }

    const vectors = await embedTexts(chunks);
    if (vectors.length !== chunks.length) {
      throw new Error(
        `embedding 数量与 chunk 数量不一致:${vectors.length} vs ${chunks.length}`,
      );
    }

    const rows = chunks.map((content, i) => ({
      document_id: documentId,
      user_id: userId,
      content,
      embedding: vectors[i],
      metadata: { index: i },
    }));

    for (let i = 0; i < rows.length; i += CHUNK_INSERT_BATCH) {
      const batch = rows.slice(i, i + CHUNK_INSERT_BATCH);
      const { error } = await admin.from("document_chunks").insert(batch);
      if (error) {
        throw new Error(
          `写入 document_chunks 失败(批次 ${Math.floor(i / CHUNK_INSERT_BATCH) + 1}):${error.message}`,
        );
      }
    }

    const { error: updErr } = await admin
      .from("documents")
      .update({
        status: "ready",
        char_count: charCount,
        chunk_count: chunks.length,
        error_message: null,
      })
      .eq("id", documentId)
      .eq("user_id", userId);

    if (updErr) {
      throw new Error(`更新 documents 状态失败:${updErr.message}`);
    }

    return { charCount, chunkCount: chunks.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // 回滚:删除已写入的 chunks,避免残留
    await admin
      .from("document_chunks")
      .delete()
      .eq("document_id", documentId)
      .eq("user_id", userId);

    // 标记为 failed(尽力而为,不覆盖原始错误)
    await admin
      .from("documents")
      .update({
        status: "failed",
        error_message: message.slice(0, 1000),
      })
      .eq("id", documentId)
      .eq("user_id", userId);

    throw err;
  }
}
