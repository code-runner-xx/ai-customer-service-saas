import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validators/ingest";

export const runtime = "nodejs";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) {
    return NextResponse.json({ error: "非法的 id" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  // 依赖 RLS + 显式 eq('id'),document_chunks 通过外键 cascade 自动删除
  const { data, error } = await supabase
    .from("documents")
    .delete()
    .eq("id", parsed.data)
    .select("id");

  if (error) {
    return NextResponse.json(
      { error: `删除失败:${error.message}` },
      { status: 500 },
    );
  }

  if (!data || data.length === 0) {
    return NextResponse.json({ error: "文档不存在" }, { status: 404 });
  }

  return new NextResponse(null, { status: 204 });
}
