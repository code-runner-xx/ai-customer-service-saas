import { notFound } from 'next/navigation';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import PublicChatClient from './PublicChatClient';

interface PageProps {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ embed?: string }>;
}

export default async function PublicChatPage({ params, searchParams }: PageProps) {
  const { tenantId } = await params;
  const { embed } = await searchParams;

  // 1. 校验 tenantId 是合法 UUID，格式非法直接 notFound（不 throw，避免 Next 包成 500）
  const uuidResult = z.string().uuid().safeParse(tenantId);
  if (!uuidResult.success) notFound();

  // 2. 校验该租户下存在至少 1 条 status='ready' 的文档
  //    使用 admin client（C 端匿名访问，绕 RLS），业务层显式过滤 user_id
  const admin = createAdminClient();
  const { data } = await admin
    .from('documents')
    .select('id')
    .eq('user_id', tenantId)
    .eq('status', 'ready')
    .limit(1)
    .maybeSingle();

  if (!data) notFound();

  const isEmbed = embed === '1';

  // embed=1：宿主页 iframe 嵌入模式，透明背景、无 header、贴边无 padding
  if (isEmbed) {
    return (
      <div className="h-dvh bg-transparent overflow-hidden">
        <PublicChatClient tenantId={tenantId} />
      </div>
    );
  }

  // 普通分享链接直接打开：极简 header + 聊天区域
  return (
    <div className="flex flex-col h-dvh bg-background">
      <header className="shrink-0 flex items-center h-14 border-b px-4">
        <h1 className="text-base font-semibold text-foreground">AI 客服</h1>
      </header>
      {/* min-h-0 防止 flex 子元素撑破父容器，overflow-hidden 为 ChatWindow 提供高度约束 */}
      <main className="flex-1 min-h-0 overflow-hidden">
        <PublicChatClient tenantId={tenantId} />
      </main>
    </div>
  );
}
