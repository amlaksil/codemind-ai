import { resumeTemplate } from './templates.js';

// pdfkit is loaded on the first PDF drawn, not with the module: it brings its font parser and the
// standard fonts' metrics, a good deal of heap, and most processes (a worker, a web process whose
// members download nothing) never draw one. The promise is kept so a second PDF does not import again.
let pdfkitLoading = null;
const loadPdfDocument = () => (pdfkitLoading ??= import('pdfkit').then((m) => m.default));

// The same document model the .docx is built from (docx.js), drawn as a PDF in the same
// template: one column, real text, nothing in headers or footers, so a parser reads it as it
// reads the .docx. The PDF's standard fonts stand in for the template's — Times for Georgia,
// Helvetica for Calibri and Arial — and need no font files on the server. They carry only the
// Windows-1252 characters; anything else is written without its accent, or left out.

const FONTS = {
  serif: { regular: 'Times-Roman', bold: 'Times-Bold' },
  sans: { regular: 'Helvetica', bold: 'Helvetica-Bold' },
};
const SERIF = new Set(['Georgia', 'Times New Roman', 'Cambria', 'Garamond']);
const fontsFor = (name) => (SERIF.has(name) ? FONTS.serif : FONTS.sans);

const TWIPS = 20; // template spacing is in twentieths of a point
const BULLET_INDENT = 18;
const LABELLED_RE = /^([A-Za-z][\w &/+.-]{1,32}):\s+(.+)$/;

// Windows-1252 beyond Latin-1: what the standard fonts draw besides U+0020–U+00FF.
const CP1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const REPLACEMENTS = { '→': '->', '←': '<-', '≥': '>=', '≤': '<=', '−': '-', '‐': '-', '‑': '-', '✓': '', '★': '*', '▪': '•', '▸': '•', '►': '•', 'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'ı': 'i' };

/** Text the standard fonts can draw: accents kept where Windows-1252 has them, dropped where not. */
export function pdfSafe(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0);
    if ((code >= 0x20 && code <= 0xff) || CP1252_EXTRA.has(ch)) out += ch;
    else if (ch in REPLACEMENTS) out += REPLACEMENTS[ch];
    else if (/\s/.test(ch)) out += ' '; // tabs, line breaks, thin and narrow spaces
    else out += ch.normalize('NFKD').replace(/[^\x20-\xff]/g, '');
  }
  return out;
}

/**
 * Whether pdfSafe would leave a letter out of `text` altogether (a name in Chinese, a city in
 * Cyrillic), not just its accent: a file that goes to an employer is then better sent as .docx.
 */
export function pdfDropsLetters(text) {
  for (const ch of String(text ?? '')) {
    if (!/\p{L}/u.test(ch)) continue;
    if (!pdfSafe(ch)) return true;
  }
  return false;
}

/** Draw a document model (docx.js formResumeModel / parseTailoredResume) as a PDF. Resolves to its bytes. */
export async function renderResumePdf({ model, template }) {
  const PDFDocument = await loadPdfDocument();
  const t = resumeTemplate(template);
  const margin = t.margins * 72;
  const doc = new PDFDocument({
    size: 'LETTER',
    margin,
    info: { Title: pdfSafe(model.name ? `${model.name} - resume` : 'Resume'), Creator: 'CodeMind Jobs' },
  });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const body = fontsFor(t.fonts.body);
  const heading = fontsFor(t.fonts.heading);
  const color = (hex) => `#${hex}`;
  const left = margin;
  const width = doc.page.width - 2 * margin;
  const bottom = () => doc.page.height - margin;
  const gap = (twips) => {
    doc.y += twips / TWIPS;
  };
  // A heading or an entry line never ends a page: it moves to the next with what follows it.
  const keepWith = (height) => {
    if (doc.y + height > bottom() && doc.y > margin) doc.addPage();
  };
  const lineHeight = (size) => size * 1.25;

  /** Plain text, or "Label: rest" with the label in bold. */
  const runs = (text, label, x, w) => {
    const opts = { width: w, lineGap: 1 };
    if (label) {
      doc.font(body.bold).text(pdfSafe(`${label}: `), x, doc.y, { ...opts, continued: true });
      doc.font(body.regular).text(pdfSafe(text.slice(label.length).replace(/^:\s*/, '')), opts);
    } else {
      doc.font(body.regular).text(pdfSafe(text), x, doc.y, opts);
    }
  };

  doc.fillColor(color(t.colors.text));
  if (model.name) {
    doc.font(heading.bold).fontSize(t.sizes.name).fillColor(color(t.colors.name)).text(pdfSafe(model.name), left, doc.y, { width });
    gap(40);
  }
  if (model.title) {
    doc.font(body.regular).fontSize(t.sizes.title).fillColor(color(t.colors.muted)).text(pdfSafe(model.title), left, doc.y, { width });
    gap(40);
  }
  if (model.contact?.length) {
    doc.font(body.regular).fontSize(t.sizes.small).fillColor(color(t.colors.muted)).text(pdfSafe(model.contact.join(t.header.separator)), left, doc.y, { width });
    gap(t.spacing.paragraph);
  }

  for (const section of model.sections || []) {
    gap(t.spacing.sectionBefore);
    keepWith(lineHeight(t.sizes.heading) + lineHeight(t.sizes.body) * 2);
    const text = t.heading.uppercase ? section.heading.toUpperCase() : section.heading;
    doc
      .font(heading.bold)
      .fontSize(t.sizes.heading)
      .fillColor(color(t.colors.heading))
      .text(pdfSafe(text), left, doc.y, { width, characterSpacing: (t.heading.letterSpacing || 0) / TWIPS });
    if (t.heading.rule) {
      const y = doc.y + 1;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.75).strokeColor(color(t.colors.rule)).stroke();
      doc.y = y + 2;
    }
    gap(t.spacing.sectionAfter);
    doc.fillColor(color(t.colors.text)).fontSize(t.sizes.body);

    for (const block of section.blocks || []) {
      if (block.type === 'entry') {
        gap(t.spacing.entryBefore);
        keepWith(lineHeight(t.sizes.body) * 2);
        const y = doc.y;
        let datesWidth = 0;
        if (block.dates) {
          const dates = pdfSafe(block.dates);
          doc.font(body.regular).fontSize(t.sizes.small);
          datesWidth = doc.widthOfString(dates);
          // Set on the title's baseline: the smaller dates sit lower by the size difference.
          doc.fillColor(color(t.colors.muted)).text(dates, left + width - datesWidth, y + (t.sizes.body - t.sizes.small) * 0.8, { lineBreak: false });
        }
        const titleWidth = width - (datesWidth ? datesWidth + 12 : 0);
        doc.fontSize(t.sizes.body).fillColor(color(t.colors.text));
        if (block.org) {
          doc.font(body.bold).text(pdfSafe(block.title), left, y, { width: titleWidth, continued: true });
          doc.font(body.regular).text(pdfSafe(`  ·  ${block.org}`));
        } else {
          doc.font(body.bold).text(pdfSafe(block.title), left, y, { width: titleWidth });
        }
        gap(t.spacing.bullet);
      } else if (block.type === 'bullets') {
        for (const item of block.items) {
          keepWith(lineHeight(t.sizes.body));
          const y = doc.y;
          doc.font(body.regular).fontSize(t.sizes.body).text('•', left + 5, y, { lineBreak: false });
          doc.y = y;
          const label = item.match(LABELLED_RE)?.[1];
          runs(item, label, left + BULLET_INDENT, width - BULLET_INDENT);
          gap(t.spacing.bullet);
        }
      } else {
        doc.fontSize(t.sizes.body);
        runs(block.text || '', block.label, left, width);
        gap(t.spacing.paragraph);
      }
    }
  }

  doc.end();
  return done;
}

/**
 * A cover letter's text as a PDF, laid out as its .docx is (docx.js buildCoverLetterDocx): a
 * blank line starts a paragraph, a single line break stays one, in the template's body font, size
 * and margins (at least an inch). Resolves to its bytes.
 */
export async function renderCoverLetterPdf({ text, template }) {
  const PDFDocument = await loadPdfDocument();
  const t = resumeTemplate(template);
  const margin = Math.max(t.margins, 1) * 72;
  const doc = new PDFDocument({ size: 'LETTER', margin, info: { Title: 'Cover letter', Creator: 'CodeMind Jobs' } });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const width = doc.page.width - 2 * margin;
  const paragraphs = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').map((line) => pdfSafe(line).trimEnd()).join('\n'))
    .filter((p) => p.trim());
  doc.font(fontsFor(t.fonts.body).regular).fontSize(t.sizes.body).fillColor(`#${t.colors.text}`);
  for (const paragraph of paragraphs) {
    doc.text(paragraph, margin, doc.y, { width, lineGap: 1 });
    doc.y += t.sizes.body; // one blank line between paragraphs
  }

  doc.end();
  return done;
}
