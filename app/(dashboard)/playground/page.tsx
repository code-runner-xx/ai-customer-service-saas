import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import ChatWindow from '@/components/chat/ChatWindow';

export default async function PlaygroundPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  return (
    // -m-6 抵消 layout main 的 p-6,让聊天窗口铺满剩余区域
    <div className="h-full -m-6 flex flex-col overflow-hidden">
      <ChatWindow tenantId={user.id} mode="playground" />
    </div>
  );
}
