// Text from uploaded documents. Open source, runs on the RedClinic server, nothing is sent to another company.
//  - Digital PDFs: the text layer, page by page (pdf.js).
//  - Photos and scans (JPEG/PNG, and PDFs with no text layer are reported as such): OCR with Tesseract in English,
//    Hindi and Kannada, using language data shipped with the app (no download at run time).
import path from "node:path";

export interface ExtractedText { method: "pdf_text" | "ocr" | "simulated"; pages: { page: number; text: string }[]; confidence: number | null; language: string | null }
export interface TextExtractor { extract(bytes: Buffer, mime: string): Promise<ExtractedText> }

async function pdfText(bytes: Buffer): Promise<ExtractedText> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true }).promise;
  const pages: ExtractedText["pages"] = [];
  for (let i = 1; i <= Math.min(doc.numPages, 30); i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    // rebuild lines from the text items' positions (same y = same line)
    const lines = new Map<number, { x: number; s: string }[]>();
    for (const it of content.items as { str: string; transform: number[] }[]) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.transform[5]);
      const key = [...lines.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      (lines.get(key) ?? lines.set(key, []).get(key)!).push({ x: it.transform[4], s: it.str });
    }
    const text = [...lines.entries()].sort((a, b) => b[0] - a[0])
      .map(([, parts]) => parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(" ").replace(/\s+/g, " ").trim()).join("\n");
    pages.push({ page: i, text });
  }
  await doc.destroy();
  return { method: "pdf_text", pages, confidence: null, language: null };
}

// @tesseract.js-data/<lang>/4.0.0_best_int/<lang>.traineddata.gz (copied into the standalone build by next.config.ts).
// Built at run time from the working directory so the bundler does not try to bundle the data files.
const langFile = (l: string) => path.join(process.cwd(), "node_modules", "@tesseract.js-data", l, "4.0.0_best_int", `${l}.traineddata.gz`);

async function ocr(bytes: Buffer): Promise<ExtractedText> {
  const { createWorker } = await import("tesseract.js");
  const langs = ["eng", "hin", "kan"];
  // each language lives in its own package folder; tesseract.js wants one folder, so point it at a shared cache
  const cache = path.join(process.env.STORAGE_DIR ?? "/tmp", ".ocr-lang");
  const { mkdir, copyFile, access } = await import("node:fs/promises");
  await mkdir(cache, { recursive: true });
  for (const l of langs) {
    const dst = path.join(cache, `${l}.traineddata.gz`);
    await access(dst).catch(() => copyFile(langFile(l), dst));
  }
  const worker = await createWorker(langs, 1, { langPath: cache, cachePath: cache, gzip: true, logger: () => {} });
  try {
    const r = await worker.recognize(bytes);
    return { method: "ocr", pages: [{ page: 1, text: r.data.text.trim() }], confidence: Math.round(r.data.confidence), language: "eng+hin+kan" };
  } finally { await worker.terminate(); }
}

export class OpenSourceExtractor implements TextExtractor {
  async extract(bytes: Buffer, mime: string): Promise<ExtractedText> {
    if (mime === "application/pdf") return pdfText(bytes);
    if (mime === "image/jpeg" || mime === "image/png") return ocr(bytes);
    throw new Error("This kind of file cannot be read yet.");
  }
}

/** Tests only: returns the text it was given. */
export class SimulatedExtractor implements TextExtractor {
  constructor(private readonly text: string) {}
  async extract() { return { method: "simulated" as const, pages: [{ page: 1, text: this.text }], confidence: 90, language: "eng" }; }
}

let extractor: TextExtractor | undefined;
export const getExtractor = () => (extractor ??= new OpenSourceExtractor());
/** Tests only. */
export const setExtractor = (e: TextExtractor | undefined) => { extractor = e; };
