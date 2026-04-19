import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 800,
  chunkOverlap: 150,
});

export async function chunkText(text: string): Promise<string[]> {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const raw = await splitter.splitText(normalized);
  return raw.map((c) => c.trim()).filter((c) => c.length >= 20);
}
