'use client';

import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="flex flex-col items-center gap-4 text-center">
        <AlertTriangle className="size-12 text-muted-foreground" />
        <h1 className="text-xl font-semibold text-foreground">出了点问题</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {process.env.NODE_ENV === 'development'
            ? error.message
            : '请刷新页面或稍后重试'}
        </p>
        <Button variant="outline" onClick={reset}>
          重试
        </Button>
      </div>
    </div>
  );
}
