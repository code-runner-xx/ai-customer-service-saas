'use client';

import { useEffect, useState } from 'react';
import { nanoid } from 'nanoid';
import ChatWindow from '@/components/chat/ChatWindow';

interface Props {
  tenantId: string;
}

export default function PublicChatClient({ tenantId }: Props) {
  const [visitorId, setVisitorId] = useState<string | null>(null);

  useEffect(() => {
    // 必须在 useEffect 里读写 localStorage，避免 SSR 阶段访问 window 报错
    let id = localStorage.getItem('aics_visitor_id');
    if (!id) {
      id = nanoid();
      localStorage.setItem('aics_visitor_id', id);
    }
    setVisitorId(id);
  }, []);

  if (visitorId === null) {
    // visitorId 尚未就绪，先占位——避免 useChat 以 undefined visitorId 初始化后
    // visitorId 变更导致 hook 状态混乱
    return <div className="h-full" />;
  }

  return (
    <div className="h-full">
      <ChatWindow tenantId={tenantId} mode="public" visitorId={visitorId} />
    </div>
  );
}
