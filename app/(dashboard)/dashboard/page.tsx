import { BookOpen, MessageCircle, MessagesSquare } from "lucide-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const supabase = await createClient();

  const [documentsRes, sessionsRes, messagesRes] = await Promise.all([
    supabase.from("documents").select("*", { count: "exact", head: true }),
    supabase.from("chat_sessions").select("*", { count: "exact", head: true }),
    // 依赖 own_messages RLS 策略(CLAUDE.md 第 4 节),含 session join 子查询。
    // 数据量大时若有性能问题,可改为物化列或直接在 chat_messages 表加 user_id 冗余字段。
    supabase.from("chat_messages").select("*", { count: "exact", head: true }),
  ]);

  const stats = [
    {
      label: "文档数",
      value: documentsRes.count ?? 0,
      icon: BookOpen,
    },
    {
      label: "会话数",
      value: sessionsRes.count ?? 0,
      icon: MessageCircle,
    },
    {
      label: "消息数",
      value: messagesRes.count ?? 0,
      icon: MessagesSquare,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">概览</h1>
        <p className="text-muted-foreground text-sm mt-1">
          查看你的知识库和对话使用情况
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
  );
}
