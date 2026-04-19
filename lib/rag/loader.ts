import * as cheerio from 'cheerio';

// 扫描件检测阈值:平均每页 < 50 字符判定为图像 PDF,阻断入库并提示用户。
// Step 16 引入 OCR 后再校准此阈值。
const SCANNED_PDF_CHAR_PER_PAGE_THRESHOLD = 50;

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

  // 页间用双换行分隔,保留页边界利于后续 chunk overlap
  return pages.join('\n\n').trim();
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

  const title = ($('title').first().text() || url).trim();
  const text = $('body')
    .text()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();

  return { title, text };
}
