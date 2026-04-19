import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 让 Next.js 把这些库当作 Node 外部依赖,不参与 webpack 打包。
  // 原因:它们是 CJS 库且有顶层副作用(`Object.defineProperty(exports, ...)`),
  // RSC 打包会报 "Object.defineProperty called on non-object"。
  // 详见 CLAUDE.md 的 "Node 库互操作坑" 小节。
  // - mammoth:解析 .docx,CJS 库,必须动态 import + 外部化
  // - unpdf 是纯 ESM 不需要放这里;pdf-parse 已于 Step 15 移除
  serverExternalPackages: ["mammoth"],

  async headers() {
    return [
      {
        // Next.js 默认给所有页面加 X-Frame-Options: SAMEORIGIN，会阻止跨域 iframe 嵌入。
        // /chat/* 是公开聊天页，需要允许任意第三方网站通过 widget.js iframe 嵌入。
        // CSP frame-ancestors 在现代浏览器中优先级高于 X-Frame-Options，可覆盖默认行为。
        // 注意：只对 /chat/* 放开，其余路径保持 SAMEORIGIN 安全策略不变。
        source: "/chat/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors *",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
