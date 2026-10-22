import { AiError } from '../errors.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// The two readers are loaded on the first upload of their kind, not with the module: pdf-parse
// brings the whole of pdf.js and mammoth its own XML stack, several megabytes of heap each, and
// most processes (a worker, a web process whose members upload nothing) never read a file. The
// promise is kept so a second upload does not import again.
let pdfParseLoading = null;
let mammothLoading = null;
const loadPdfParse = () => (pdfParseLoading ??= import('pdf-parse').then((m) => m.default));
const loadMammoth = () => (mammothLoading ??= import('mammoth').then((m) => m.default));

// A resume is a few pages; anything past this is not one, and every page costs time on the event loop.
const MAX_PDF_PAGES = 40;
// Nor is more text than this (a long resume is 20,000 characters). The text is stored with the
// resume twice over and read back on every job page, and a 10 MB text file would not even fit a
// document.
export const MAX_TEXT_CHARS = 200_000;

const unreadable = (err) => {
  const reason = /password|encrypt/i.test(String(err?.message)) ? 'It is password-protected.' : 'Is it a valid, unencrypted PDF or DOCX?';
  return AiError.badRequest(`Could not read this file. ${reason}`);
};

// A gap between two pieces of text on a line wider than this share of the font size is a space.
// A space is about a quarter of an em; kerning and letter spacing stay well under this.
const WORD_GAP_EM = 0.15;

const fontSize = (item) => Math.hypot(item.transform[2], item.transform[3]) || item.height || 0;

/**
 * One page's text: pieces on the same baseline joined, a new line where the baseline moves.
 * pdf-parse's own renderer joins same-line pieces with nothing between them, and many PDFs
 * (LaTeX, Typst, justified Word exports, design tools) draw each word as its own piece and
 * leave the space out, placing the next word by position alone: their text came out as
 * "BuildingupanewAIdepartment". Here a visible gap between two pieces is a space.
 */
export function pageText(items) {
  let text = '';
  let last = null;
  for (const item of items) {
    const [x, y] = [item.transform[4], item.transform[5]];
    if (last && y !== last.y) text += '\n';
    else if (last && item.str && !/\s$/.test(text) && !/^\s/.test(item.str)) {
      const gap = x - last.end;
      const em = fontSize(item) || last.size;
      // A piece that starts well back to the left on the same line is not the same word either.
      if (em && (gap > WORD_GAP_EM * em || gap < -em)) text += ' ';
    }
    text += item.str;
    last = { y, end: x + (item.width || 0), size: fontSize(item) };
  }
  return text;
}

const renderPage = (pageData) => pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }).then((content) => pageText(content.items));

async function readText(buffer, mimeType, name) {
  if (mimeType === 'application/pdf' || name.endsWith('.pdf')) {
    try {
      // A copy of its own: a small Buffer is a slice of Node's shared pool, and pdf-parse's pdf.js
      // reads the whole underlying ArrayBuffer from offset 0, so it saw the pool and "bad XRef".
      const pdfParse = await loadPdfParse();
      const data = await pdfParse(new Uint8Array(buffer), { max: MAX_PDF_PAGES, pagerender: renderPage });
      return data.text;
    } catch (err) {
      throw unreadable(err);
    }
  }
  if (mimeType === DOCX || name.endsWith('.docx')) {
    try {
      const mammoth = await loadMammoth();
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } catch (err) {
      throw unreadable(err);
    }
  }
  if (mimeType === 'text/plain' || name.endsWith('.txt')) {
    return buffer.toString('utf-8');
  }
  throw AiError.badRequest('Unsupported file type. Upload a PDF, DOCX, or TXT file.');
}

/** Plain text from an uploaded resume buffer, by MIME type or extension. A broken, protected or outsized file is the user's to fix (400). */
export async function extractText(buffer, { mimeType = '', filename = '' } = {}) {
  const text = await readText(buffer, mimeType, filename.toLowerCase());
  if (text.length > MAX_TEXT_CHARS) throw AiError.badRequest('This file holds far more text than a resume. Upload the resume on its own.');
  return text;
}

export const ALLOWED_MIME_TYPES = ['application/pdf', DOCX, 'text/plain'];
export const ALLOWED_EXTENSIONS = /\.(pdf|docx|txt)$/i;
