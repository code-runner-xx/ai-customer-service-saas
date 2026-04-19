'use client';

import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface Props {
  scriptTag: string;
}

export default function EmbedCodeCard({ scriptTag }: Props) {
  const handleCopy = async () => {
    await navigator.clipboard.writeText(scriptTag);
    toast.success('已复制');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">嵌入网站</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          将以下代码粘贴到你网站 HTML 的 &lt;body&gt; 标签底部，即可在页面右下角嵌入聊天组件。
        </p>
        <pre className="overflow-x-auto rounded-md border bg-muted/50 px-4 py-3 font-mono text-sm">
          <code>{scriptTag}</code>
        </pre>
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={handleCopy}>
            <Copy className="mr-1.5 size-3.5" />
            复制代码
          </Button>
          <p className="text-xs text-muted-foreground">
            嵌入功能将在后续版本启用，当前复制的代码暂不生效
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
