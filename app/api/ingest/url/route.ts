import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadUrl } from "@/lib/rag/loader";
import { processAndStoreDocument } from "@/lib/rag/ingest";
import { ingestUrlSchema, MIN_TEXT_LENGTH } from "@/lib/validators/ingest";

export const runtime = "nodejs";

export async function POST(request: Request) {
  // ---------- 第一关卡:廉价校验 ----------
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = ingestUrlSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数错误" },
      { status: 400 },
    );
  }
  const { url } = parsed.data;

  // 抓取网页:此步也属于第一关卡(抓不到或内容太短 → 直接拒绝,不写 failed)
  let title: string;
  let text: string;
  try {
    const loaded = await loadUrl(url);
    title = loaded.title;
    text = loaded.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `抓取网页失败:${message}` },
      { status: 400 },
    );
  }

  if (!text || text.trim().length < MIN_TEXT_LENGTH) {
    return NextResponse.json(
      { error: "网页内容为空或太短(可能是反爬或 JS 渲染页面)" },
      { status: 400 },
    );
  }

  // ---------- 第二关卡:建 row + 切块 + embedding ----------
  const admin = createAdminClient();
  const { data: doc, error: insertErr } = await admin
    .from("documents")
    .insert({
      user_id: user.id,
      title: title || url,
      content_type: "url",
      source_url: url,
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
    return NextResponse.json(
      { error: `处理失败:${message}`, id: doc.id },
      { status: 500 },
    );
  }
}
