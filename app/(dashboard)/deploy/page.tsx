import { BookOpen, MessageCircle, MessagesSquare } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import ShareLinkCard from './_components/ShareLinkCard';
import EmbedCodeCard from './_components/EmbedCodeCard';

export default async function DeployPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // layout.tsx 已守护登录，此处 user 必然存在
  const userId = user!.id;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const chatUrl = `${appUrl}/chat/${userId}`;
  const scriptTag = `<script src="${appUrl}/widget.js?t=${userId}" async></script>`;

  // 统计数据：RLS 自动过滤当前用户，documents 额外限 status='ready'
  const [documentsRes, sessionsRes, messagesRes] = await Promise.all([
    supabase
      .from('documents')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'ready'),
    supabase.from('chat_sessions').select('*', { count: 'exact', head: true }),
    supabase.from('chat_messages').select('*', { count: 'exact', head: true }),
  ]);

  const stats = [
    {
      label: '文档数',
      value: documentsRes.count ?? 0,
      icon: BookOpen,
    },
    {
      label: '会话数',
      value: sessionsRes.count ?? 0,
      icon: MessageCircle,
    },
    {
      label: '消息数',
      value: messagesRes.count ?? 0,
      icon: MessagesSquare,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">部署</h1>
        <p className="text-sm text-muted-foreground mt-1">
          将 AI 客服分享给用户或嵌入到你的网站
        </p>
      </div>

      {/* 分享链接 + 嵌入代码：移动端上下堆叠，md 以上左右并排 */}
      <div className="grid gap-4 md:grid-cols-2">
        <ShareLinkCard chatUrl={chatUrl} />
        <EmbedCodeCard scriptTag={scriptTag} />
      </div>

      {/* 统计数据 */}
      <div>
        <h2 className="text-sm font-medium text-muted-foreground mb-3">使用统计</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {stats.map(({ label, value, icon: Icon }) => (
            <Card key={label}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {label}
                </CardTitle>
                <Icon className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{value}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
