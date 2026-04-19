'use client';

import { Copy, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface Props {
  chatUrl: string;
}

export default function ShareLinkCard({ chatUrl }: Props) {
  const handleCopy = async () => {
    await navigator.clipboard.writeText(chatUrl);
    toast.success('已复制');
  };

  const handleOpen = () => {
    window.open(chatUrl, '_blank');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">分享链接</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          将以下链接发送给用户，他们无需登录即可直接与你的 AI 客服对话。
        </p>
        <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
          <span className="flex-1 truncate font-mono text-sm">{chatUrl}</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleCopy}>
            <Copy className="mr-1.5 size-3.5" />
            复制链接
          </Button>
          <Button variant="outline" size="sm" onClick={handleOpen}>
            <ExternalLink className="mr-1.5 size-3.5" />
            新窗口打开
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
