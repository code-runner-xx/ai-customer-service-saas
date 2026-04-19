import { MessageCircleX } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="flex flex-col items-center gap-4 text-center">
        <MessageCircleX className="size-12 text-muted-foreground" />
        <h1 className="text-xl font-semibold text-foreground">
          客服链接无效
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          该链接对应的客服不存在或尚未配置知识库，请联系服务提供方确认链接。
        </p>
      </div>
    </div>
  );
}
