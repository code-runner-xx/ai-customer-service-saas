import { type NextRequest } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const t = request.nextUrl.searchParams.get('t');

  // tenantId 格式非法 → 静默返回空脚本，不暴露错误信息给第三方宿主页面
  const result = z.string().uuid().safeParse(t);
  if (!result.success) {
    return new Response('// invalid', {
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
    });
  }

  const tenantId = result.data;
  // NEXT_PUBLIC_APP_URL 优先；未配置时 fallback 到请求来源 origin（本地开发友好）
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;

  return new Response(buildScript(appUrl, tenantId), {
    headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
  });
}

// ---------- IIFE 脚本生成 ----------
// APP_URL 与 tenantId 在服务端注入，避免客户端暴露拼接逻辑。
// 返回的 JS 是纯原生代码，不依赖任何框架，可安全注入第三方网站。
function buildScript(appUrl: string, tenantId: string): string {
  const chatUrl = `${appUrl}/chat/${tenantId}?embed=1`;

  return `(function () {
  // 幂等保护：多次加载 script 只初始化一次
  if (window.__aics_loaded) return;
  window.__aics_loaded = true;

  var CHAT_URL = '${chatUrl}';

  // ---- SVG 图标（内联，无外部依赖）----
  var ICON_CHAT =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" ' +
    'viewBox="0 0 24 24" fill="white">' +
    '<path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>' +
    '</svg>';
  var ICON_CLOSE =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" ' +
    'viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<line x1="18" y1="6" x2="6" y2="18"/>' +
    '<line x1="6" y1="6" x2="18" y2="18"/>' +
    '</svg>';

  // ---- 品牌色常量 ----
  var ACCENT_BRAND = 'oklch(0.488 0.196 264)';  // FAB 关闭态:与 C 端聊天页用户气泡同色
  var DEEP_GREY = 'oklch(0.3 0 0)';             // FAB 打开态:避免与强调色打架,保持单色稀缺

  // ---- 注入 style 标签:tooltip 基础样式 + 窄屏 media query ----
  // inline style 无法写 @media 规则,只能通过 stylesheet;媒体查询用 !important 覆盖 inline
  var styleEl = document.createElement('style');
  styleEl.id = '__aics_styles';
  styleEl.textContent =
    "#__aics_tooltip{" +
      "position:fixed;bottom:40px;right:92px;z-index:2147482999;" +
      "background:#fff;color:oklch(0.145 0 0);font-size:13px;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "padding:8px 12px;border-radius:8px;" +
      "border:1px solid oklch(0.922 0 0);" +
      "box-shadow:0 2px 8px rgba(0,0,0,.08);" +
      "white-space:nowrap;cursor:default;" +
      "display:flex;align-items:center;" +
    "}" +
    "#__aics_tooltip::after{" +
      "content:'';position:absolute;right:-5px;top:50%;" +
      "width:10px;height:10px;background:#fff;" +
      "border-top:1px solid oklch(0.922 0 0);" +
      "border-right:1px solid oklch(0.922 0 0);" +
      "transform:translateY(-50%) rotate(45deg);" +
      "border-top-right-radius:3px;" +
    "}" +
    "@media (max-width:400px){" +
      "#__aics_btn{right:16px !important;}" +
      "#__aics_tooltip{right:88px !important;}" +
    "}";
  document.head.appendChild(styleEl);

  // ---- iframe 容器（id 前缀 __aics_ 避免与宿主页面冲突）----
  var frame = document.createElement('div');
  frame.id = '__aics_frame';

  var iframe = document.createElement('iframe');
  iframe.setAttribute('src', CHAT_URL);
  iframe.setAttribute('title', 'AI 智能客服');
  iframe.setAttribute('allow', 'clipboard-write');
  iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;';
  frame.appendChild(iframe);

  // ---- 悬浮按钮（全部 inline style，不污染宿主页面）----
  var btn = document.createElement('button');
  btn.id = '__aics_btn';
  btn.setAttribute('aria-label', '打开客服窗口');
  btn.style.cssText =
    'position:fixed;bottom:24px;right:24px;z-index:2147483000;' +
    'width:56px;height:56px;border-radius:50%;' +
    'background:' + ACCENT_BRAND + ';border:none;cursor:pointer;' +
    'box-shadow:0 4px 12px rgba(0,0,0,.25);' +
    'display:flex;align-items:center;justify-content:center;padding:0;' +
    'transition:filter .15s,background .2s;';
  btn.innerHTML = ICON_CHAT;

  btn.addEventListener('mouseenter', function () {
    btn.style.filter = 'brightness(1.15)';
  });
  btn.addEventListener('mouseleave', function () {
    btn.style.filter = '';
  });

  // ---- tooltip:闭合态常驻招呼语,打开后隐藏 ----
  // 方案 a(无淡入/无延迟):加载即可见,点 FAB 打开时 display:none,关闭恢复
  var tooltip = document.createElement('div');
  tooltip.id = '__aics_tooltip';
  tooltip.textContent = '有什么可以帮您?';

  // ---- 布局计算：移动端全屏 / 桌面端悬浮窗 ----
  function applyFrameStyle(visible) {
    if (!visible) {
      frame.style.cssText = 'display:none;';
      return;
    }
    var mobile = window.innerWidth < 640;
    var base =
      'display:block;position:fixed;z-index:2147483000;overflow:hidden;';
    if (mobile) {
      // 移动端全屏，使用 dvh 避免 Safari 地址栏遮挡
      frame.style.cssText =
        base + 'bottom:0;right:0;width:100vw;height:100dvh;border-radius:0;';
    } else {
      frame.style.cssText =
        base +
        'bottom:96px;right:24px;width:380px;height:560px;' +
        'border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.2);';
    }
  }

  // ---- 状态管理 ----
  var isOpen = false;

  function open() {
    isOpen = true;
    applyFrameStyle(true);
    btn.innerHTML = ICON_CLOSE;
    btn.setAttribute('aria-label', '关闭客服窗口');
    btn.style.background = DEEP_GREY;
    tooltip.style.display = 'none';
  }

  function close() {
    isOpen = false;
    applyFrameStyle(false);
    btn.innerHTML = ICON_CHAT;
    btn.setAttribute('aria-label', '打开客服窗口');
    btn.style.background = ACCENT_BRAND;
    tooltip.style.display = 'flex';
  }

  function toggle() {
    if (isOpen) { close(); } else { open(); }
  }

  btn.addEventListener('click', toggle);

  // ---- 挂载到 DOM ----
  applyFrameStyle(false);
  document.body.appendChild(frame);
  document.body.appendChild(btn);
  document.body.appendChild(tooltip);

  // ---- 全局 API ----
  window.AICS = { open: open, close: close, toggle: toggle };
})();`;
}
