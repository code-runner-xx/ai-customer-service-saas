import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * 匹配所有请求路径,除了:
     * - _next/static / _next/image(静态资源)
     * - favicon.ico / robots.txt / sitemap.xml
     * - 常见图片后缀
     * - /chat/* (P4 C 端公开聊天页,显式放行)
     * - /widget.js(P5 嵌入脚本,显式放行)
     */
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|chat/|widget\\.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)).*)",
  ],
};
