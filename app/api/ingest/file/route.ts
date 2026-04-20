import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadPdf, loadTxt, loadDocx } from "@/lib/rag/loader";
import { processAndStoreDocument } from "@/lib/rag/ingest";
import {
  MAX_FILE_SIZE,
  MIN_TEXT_LENGTH,
} from "@/lib/validators/ingest";

export const runtime = "nodejs";
// Vercel Hobby 默认 10s 超时,PDF/docx 解析 + 批量 embedding 接近边界,显式拉到 60s
export const maxDuration = 60;

type SupportedExt = "pdf" | "txt" | "docx";

function pickExt(filename: string): SupportedExt | null {
  const m = filename.toLowerCase().match(/\.([^.]+)$/);
  if (!m) return null;
  if (m[1] === "pdf") return "pdf";
  if (m[1] === "txt") return "txt";
  if (m[1] === "docx") return "docx";
  return null;
}

// .doc 是老版二进制 Word 格式,mammoth 不支持,显式识别用于友好提示
function isLegacyDoc(filename: string): boolean {
  return /\.doc$/i.test(filename);
}

function stripExt(filename: string): string {
  return filename.replace(/\.[^.]+$/, "") || filename;
}

export async function POST(request: Request) {
  // ---------- 第一关卡:廉价校验,失败直接返回,不写 documents ----------
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "请求格式错误,需要 multipart/form-data" },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "缺少 file 字段或字段类型错误" },
      { status: 400 },
    );
  }

  // 老版 .doc 单独拦截,给明确提示(mammoth 只支持 .docx OOXML 格式)
  if (isLegacyDoc(file.name)) {
    return NextResponse.json(
      { error: "暂不支持 .doc 老格式,请在 Word 中另存为 .docx 后上传" },
      { status: 415 },
    );
  }

  const ext = pickExt(file.name);
  if (!ext) {
    return NextResponse.json(
      { error: "仅支持 .pdf / .txt / .docx 文件" },
      { status: 415 },
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `文件过大,最大允许 ${MAX_FILE_SIZE / 1024 / 1024}MB` },
      { status: 413 },
    );
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "文件为空" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const title = stripExt(file.name);

  // ---------- 第二关卡:先建 documents 行,再做解析/embedding ----------
  const admin = createAdminClient();
  const { data: doc, error: insertErr } = await admin
    .from("documents")
    .insert({
      user_id: user.id,
      title,
      content_type: ext,
      status: "processing",
    })
    .select("id")
    .single();

  if (insertErr || !doc) {
    return NextResponse.json(
      { error: `创建文档记录失败:${insertErr?.message ?? "未知错误"}` },
      { status: 500 },
    );
  }

  try {
    let text: string;
    if (ext === "pdf") {
      text = await loadPdf(buffer);
    } else if (ext === "docx") {
      text = await loadDocx(buffer);
    } else {
      text = await loadTxt(buffer);
    }

    if (!text || text.trim().length < MIN_TEXT_LENGTH) {
      throw new Error("文档内容为空或过短");
    }

    const { chunkCount } = await processAndStoreDocument({
      userId: user.id,
      documentId: doc.id,
      text,
    });

    return NextResponse.json({
      id: doc.id,
      status: "ready",
      chunkCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 兜底:loader 层(loadPdf 扫描件判定 / loadDocx 解析失败)抛错时,
    // documents 停在 processing,此处显式转 failed 让前端"失败"徽章 tooltip 能显示原因。
    // processAndStoreDocument 自身也会把 processing 转 failed,此处相当于幂等覆盖写。
    try {
      await admin
        .from("documents")
        .update({ status: "failed", error_message: message.slice(0, 1000) })
        .eq("id", doc.id)
        .eq("user_id", user.id);
    } catch {
      // 兜底 update 失败忽略,不覆盖主错误信息
    }
    return NextResponse.json(
      { error: `处理失败:${message}`, id: doc.id },
      { status: 500 },
    );
  }
}
