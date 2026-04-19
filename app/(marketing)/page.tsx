import Link from "next/link";
import { MessageSquareText } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

export default function MarketingPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 px-6 text-center">
      <div className="flex items-center gap-2 text-foreground">
        <MessageSquareText className="size-7" />
        <span className="text-xl font-semibold">AI 客服</span>
      </div>

      <div className="space-y-4 max-w-2xl">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          上传你的知识库,5 分钟拥有专属 AI 客服
        </h1>
        <p className="text-muted-foreground text-lg">
          基于私有文档的 RAG 问答服务。上传 PDF / TXT / 网页,生成可分享的对话页面,
          也可以一行脚本嵌入到你的网站。
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Link href="/register" className={buttonVariants({ size: "lg" })}>
          免费开始
        </Link>
        <Link
          href="/login"
          className={buttonVariants({ size: "lg", variant: "outline" })}
        >
          登录
        </Link>
      </div>
    </main>
  );
}
