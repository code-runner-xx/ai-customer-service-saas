import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  // RLS 已保证只返回当前用户自己的 documents
  const { data, error } = await supabase
    .from("documents")
    .select(
      "id, title, content_type, source_url, status, char_count, chunk_count, error_message, created_at",
    )
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: `查询失败:${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ documents: data ?? [] });
}
