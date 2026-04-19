import { redirect } from "next/navigation";
import { MessageSquareText } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { SidebarNav } from "./_components/sidebar-nav";
import { UserMenu } from "./_components/user-menu";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // middleware 已守护,这里再兜底一次
  if (!user) {
    redirect("/login");
  }

  return (
    <div className="h-screen flex overflow-hidden bg-muted/30">
      <aside className="hidden md:flex w-60 shrink-0 flex-col border-r bg-background">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <MessageSquareText className="size-5" />
          <span className="font-semibold">AI 客服</span>
        </div>
        <SidebarNav />
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-end border-b bg-background px-6">
          <UserMenu email={user.email ?? "(无邮箱)"} />
        </header>
        <main className="flex-1 overflow-hidden p-6">{children}</main>
      </div>
    </div>
  );
}
