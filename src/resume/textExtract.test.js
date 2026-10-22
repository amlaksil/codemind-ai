import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, pageText, MAX_FILE_BYTES } from './textExtract.js';

/** A one-page PDF drawing each [x, y, word] on its own, with no space characters, as LaTeX and Typst do. */
function wordsPdf(words) {
  const stream = words.map(([x, y, w]) => `BT /F1 12 Tf ${x} ${y} Td (${w}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('extractText keeps the spaces a PDF draws as gaps between words', async () => {
  // Courier is 7.2pt a glyph at 12pt; each word starts one glyph after the last one ends.
  const line = (y, words) => {
    let x = 72;
    return words.map((w) => {
      const at = [x, y, w];
      x += (w.length + 1) * 7.2;
      return at;
    });
  };
  const pdf = wordsPdf([...line(700, ['Building', 'up', 'a', 'new', 'AI', 'department']), ...line(680, ['as', 'the', 'first', 'senior', 'engineer'])]);
  const text = await extractText(pdf, { mimeType: 'application/pdf' });
  assert.equal(text.trim(), 'Building up a new AI department\nas the first senior engineer');
});

test('pageText joins touching pieces, spaces separated ones, and breaks on a new baseline', () => {
  const item = (str, x, y, width) => ({ str, width, transform: [10, 0, 0, 10, x, y] });
  assert.equal(pageText([item('Kub', 0, 50, 15), item('ernetes', 15.2, 50, 35), item('and', 53, 50, 15), item('Go', 0, 30, 10)]), 'Kubernetes and\nGo');
  // A piece that already carries its space gets no second one.
  assert.equal(pageText([item('Senior ', 0, 50, 35), item('engineer', 38, 50, 40)]), 'Senior engineer');
});

test('rejects oversized files before attempting extraction', async () => {
  const oversized = Buffer.alloc(MAX_FILE_BYTES + 1);

  await assert.rejects(
    extractText(oversized, { mimeType: 'application/pdf' }),
    (err) =>
      err.status === 400 &&
      err.code === 'bad_request' &&
      /too large/i.test(err.message)
  );
});
