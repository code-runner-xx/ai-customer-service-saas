import * as cheerio from 'cheerio';

// 扫描件检测阈值:平均每页 < 50 字符判定为图像 PDF,阻断入库并提示用户。
// Step 16 引入 OCR 后再校准此阈值。
const SCANNED_PDF_CHAR_PER_PAGE_THRESHOLD = 50;

// ---------- Step 19 (e):加载后行级噪声清理 ----------
/**
 * 行级噪声清理:过滤客服信息 / 备案 / 纯数字行 / 纯链接行 / 营业时间等常见页脚碎片。
 *
 * 与 chunk.ts 的分工(修改规则时不要弄混):
 *   - 本函数 cleanNoise:**行级**原文清理,整行命中规则 → 整行丢弃,只对 loadPdf / loadUrl 出口生效
 *   - chunk.ts 的 `.trim().length < 20` 过滤:**块级**过滤,RecursiveCharacterTextSplitter 切块后
 *     再丢弃过短 chunk
 *   两层互补:原文噪声行先剔掉,避免它们混入正文后污染 chunk 上下文;chunk 再剔除切块后
 *   的碎片(如标点独立成块的情况)。
 *
 * "尽力而为":无法 100% 干净,复杂布局、长噪声句子、伪装成正文的广告仍可能漏过。
 */
const NOISE_BLOCKLIST_KEYWORDS = [
  '工作时间',
  '客服电话',
  '客服邮箱',
  '客服QQ',
  '客服 QQ',
  '京ICP备',
  '公安备案',
  '版权所有',
  '扫码关注',
  '未经许可',
  '违法不良信息',
  '关注公众号',
  '关注我们',
];
const NOISE_PHONE_ONLY = /^[\d\-\s()]+$/;
const NOISE_EMAIL_ONLY = /^[\w.+\-]+@[\w.\-]+\.\w+$/;
const NOISE_URL_ONLY = /^https?:\/\/\S+$/;
const NOISE_TIME_SPAN = /\d{1,2}:\d{2}\s*[-—]\s*\d{1,2}:\d{2}/;

export function cleanNoise(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    // 空行保留(后续会被 replace(/\n\s*\n\s*/g, '\n\n') 归一化处理,此处不越界)
    if (trimmed.length === 0) return true;
    // ≤ 2 字符的孤立行:图标 alt 文字 / 切页残片
    if (trimmed.length <= 2) return false;
    // 纯数字 + 符号行(含至少一位数字),典型:电话 "400-xxx"、"400-xxx-xxx"、"138 xxxx xxxx"
    if (NOISE_PHONE_ONLY.test(trimmed) && /\d/.test(trimmed)) return false;
    if (NOISE_EMAIL_ONLY.test(trimmed)) return false;
    if (NOISE_URL_ONLY.test(trimmed)) return false;
    // 包含时间段格式 "8:30-22:00" 的行(通常是营业时间,即便前缀带中文也大概率是噪声)
    if (NOISE_TIME_SPAN.test(trimmed)) return false;
    // 命中任一关键字(整行丢弃,不是只替换关键字本身)
    if (NOISE_BLOCKLIST_KEYWORDS.some((kw) => trimmed.includes(kw))) return false;
    return true;
  });
  return kept.join('\n');
}

export async function loadPdf(buffer: Buffer): Promise<string> {
  // unpdf 是纯 ESM 包,静态 import 也可;为与其他 loader 风格一致,
  // 同样走动态 import(也避免未来 Next.js 构建对大型依赖做额外打包)。
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text: pages } = await extractText(pdf, {
    mergePages: false,
  });

  // 扫描件启发式:图像 PDF 的每页文字层几乎为空。
  // 单页 PDF 不走此判定以免误伤封面/海报类文档。
  const totalChars = pages.reduce((sum, p) => sum + p.trim().length, 0);
  const avgPerPage = totalPages > 0 ? totalChars / totalPages : 0;

  if (
    totalPages >= 2 &&
    avgPerPage < SCANNED_PDF_CHAR_PER_PAGE_THRESHOLD
  ) {
    throw new Error(
      `该 PDF 疑似扫描件或图像 PDF(${totalPages} 页,平均每页仅 ${Math.round(avgPerPage)} 字),当前版本暂不支持 OCR,请提供带文字层的 PDF`,
    );
  }

  // 页间用双换行分隔,保留页边界利于后续 chunk overlap;
  // Step 19 (e):输出前过一遍 cleanNoise,去掉页脚 / 客服信息 / 营业时间等常见噪声
  return cleanNoise(pages.join('\n\n').trim());
}

// mammoth 无官方 @types 声明,局部声明最小接口收窄动态 import 结果
interface MammothExtractRawTextResult {
  value: string;
  messages: Array<{ type: string; message: string }>;
}
interface MammothModule {
  extractRawText: (input: {
    buffer: Buffer;
  }) => Promise<MammothExtractRawTextResult>;
}

export async function loadDocx(buffer: Buffer): Promise<string> {
  // 动态 import 绕过 mammoth CJS 顶层副作用,避免 Next.js RSC 打包
  // 报 `Object.defineProperty called on non-object`——与 pdf-parse 同根。
  // 配合 next.config.ts 的 serverExternalPackages: ['mammoth']。
  const { extractRawText } = (await import(
    'mammoth'
  )) as unknown as MammothModule;
  const { value } = await extractRawText({ buffer });
  return value.trim();
}

export async function loadTxt(buffer: Buffer): Promise<string> {
  return buffer.toString('utf-8').trim();
}

export async function loadUrl(
  url: string,
): Promise<{ title: string; text: string }> {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; AICS-Bot/1.0; +https://github.com/)',
    },
  });
  if (!res.ok) {
    throw new Error(`抓取网页失败:HTTP ${res.status}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  $('script, style, nav, footer, header, noscript, iframe').remove();
  // Step 19 (e):广告容器。`[class*="ad"]` 会误伤 `<div class="header">` / `<div class="card">`
  // (header/card 都含字母序列 "ad"),因此收紧到 ads / ad- 前缀 / -ad 后缀四选择器组合,
  // 对 ads-top / ad-banner / google-ad / right-ad 等真实广告类名覆盖率几乎不降。
  $('[class*="ads"], [class*="ad-"], [class^="ad-"], [class$="-ad"]').remove();
  // banner / footer 容器(非 <footer> 标签) / sidebar / recommend / aside 元素
  $('[class*="banner"], [id*="footer"], [class*="sidebar"], [class*="recommend"], aside').remove();

  const title = ($('title').first().text() || url).trim();
  const text = $('body')
    .text()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();

  // Step 19 (e):行级清洁,剔除 cheerio 层漏过去的行内噪声(如正文里夹的客服电话、备案号)
  return { title, text: cleanNoise(text) };
}
