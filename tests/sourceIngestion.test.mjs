import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { extractPdfFigures, extractPdfText, ingestSource, normalizeSourceInput } from '../src/sourceIngestion.mjs';

const configuredPython = process.env.DEEPCHAT2LEARN_PYTHON_BIN || '';
const canBuildOptionalResearchFixture = Boolean(configuredPython) && spawnSync(configuredPython, ['-c', 'import pdfplumber, reportlab'], { encoding: 'utf8' }).status === 0;

function buildResearchPdf(pythonBin) {
  const script = `
from io import BytesIO
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter

buf = BytesIO()
c = canvas.Canvas(buf, pagesize=letter)
c.setFont('Helvetica', 11)
c.drawString(72, 750, 'A cohort study estimates the association between exposure and outcome.')
c.drawString(72, 730, 'Table 1. Baseline characteristics by exposure group')
left, top, width, row_height = 72, 700, 360, 22
rows = [['Group', 'N', 'Mean age'], ['Exposed', '120', '68.4'], ['Unexposed', '240', '67.1']]
for row_index in range(len(rows) + 1):
    y = top - row_index * row_height
    c.line(left, y, left + width, y)
for col in range(4):
    x = left + col * (width / 3)
    c.line(x, top, x, top - len(rows) * row_height)
for row_index, row in enumerate(rows):
    for col_index, value in enumerate(row):
        c.drawString(left + 6 + col_index * (width / 3), top - 16 - row_index * row_height, value)
c.drawString(72, 590, 'Figure 1. Adjusted association estimates with 95% confidence intervals')
c.drawString(72, 570, 'The confidence intervals are wider in the smaller exposure group.')
c.drawString(72, 550, 'The estimate includes a Unicode hyphen \\u2010 in the result.')
c.showPage()
c.save()
sys.stdout.buffer.write(buf.getvalue())
`;
  const result = spawnSync(pythonBin, ['-c', `import sys\n${script}`], { encoding: null, maxBuffer: 5_000_000 });
  assert.equal(result.status, 0, result.stderr?.toString() || 'Could not create research PDF fixture.');
  return result.stdout;
}

function makeLocalZip(entries) {
  const parts = [];
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = deflateRawSync(Buffer.from(content, 'utf8'));
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(Buffer.byteLength(content, 'utf8'), 22);
    header.writeUInt16LE(nameBytes.length, 26);
    parts.push(header, nameBytes, data);
  }
  return Buffer.concat(parts);
}

test('normalizes pasted material and keeps its name', () => {
  const result = normalizeSourceInput({ name: 'notes.md', text: 'A short source passage.' });
  assert.equal(result.name, 'notes.md');
  assert.equal(result.text, 'A short source passage.');
  assert.match(result.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.metrics, {
    bytes: Buffer.byteLength('A short source passage.', 'utf8'),
    words: 4,
    pages: null,
    chunkCount: 0,
    tableCount: 0,
    figureCount: 0,
    captionCount: 0,
    extractionMethod: 'text-direct'
  });
});

test('extracts text operators from a simple text PDF', () => {
  const pdf = Buffer.from('%PDF-1.4\nBT (Main idea) Tj (and evidence) Tj ET\n%%EOF', 'latin1');
  assert.equal(extractPdfText(pdf), 'Main idea and evidence');
  const result = normalizeSourceInput({ name: 'paper.pdf', fileBase64: pdf.toString('base64'), mimeType: 'application/pdf' });
  assert.match(result.text, /Main idea/);
  assert.equal(result.warnings.length, 2);
});

test('normalizeSourceInput preserves page-aware PDF metadata when multiple page objects are present', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj <</Type /Page>> endobj\nBT (First page claim) Tj ET\n2 0 obj <</Type /Page>> endobj\nBT (Second page evidence) Tj ET\n%%EOF', 'latin1');
  const result = normalizeSourceInput({ name: 'paper.pdf', fileBase64: pdf.toString('base64'), mimeType: 'application/pdf' });
  assert.equal(result.pages, 2);
  assert.equal(result.pageMap.length, 2);
  assert.equal(result.pageMap[0].page, 1);
  assert.equal(result.pageMap[1].page, 2);
  assert.match(result.text.slice(result.pageMap[0].start, result.pageMap[0].end), /First page claim/);
  assert.match(result.text.slice(result.pageMap[1].start, result.pageMap[1].end), /Second page evidence/);
});

test('extracts embedded PDF figure metadata alongside page-aware text', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj <</Type /Page>> endobj\n5 0 obj\n<</Type /XObject /Subtype /Image /Width 640 /Height 480 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length 12>>\nstream\nfigure-bytes\nendstream\nendobj\nBT (Figure context) Tj ET\n%%EOF', 'latin1');
  const figures = extractPdfFigures(pdf);
  assert.equal(figures.length, 1);
  assert.equal(figures[0].mimeType, 'image/jpeg');
  assert.equal(figures[0].width, 640);
  assert.equal(figures[0].height, 480);
  assert.equal(figures[0].extractionStatus, 'bytes_extracted');
  assert.equal(Buffer.from(figures[0].dataBase64, 'base64').toString('latin1'), 'figure-bytes');
  const result = normalizeSourceInput({ name: 'paper.pdf', fileBase64: pdf.toString('base64'), mimeType: 'application/pdf' });
  assert.equal(result.metadata.figureCount, 1);
  assert.equal(result.figures[0].objectNumber, 5);
  assert.ok(result.warnings.some(warning => /figures/i.test(warning)));
});

test('extracts research PDF tables and captions with optional pdfplumber', { skip: !canBuildOptionalResearchFixture }, () => {
  const pdf = buildResearchPdf(configuredPython);
  const result = normalizeSourceInput({ name: 'research-paper.pdf', fileBase64: pdf.toString('base64'), mimeType: 'application/pdf' }, { pdfPythonBin: configuredPython });
  assert.equal(result.metadata.extractionMethod, 'pdfplumber');
  assert.ok(result.tables.length >= 1);
  assert.equal(result.tables[0].page, 1);
  assert.match(result.tables[0].text, /Exposed\s*\|\s*120/);
  assert.ok(result.captions.some(caption => caption.kind === 'table' && /Baseline characteristics/i.test(caption.text)));
  assert.ok(result.captions.some(caption => caption.kind === 'figure' && /Adjusted association estimates/i.test(caption.text)));
  assert.match(result.text, /Mean age/);
  assert.match(result.text, /Adjusted association estimates/);
  assert.match(result.text, /Unicode hyphen/);
  assert.equal(result.pageMap[0].page, 1);
});

test('preserves binary PDF bytes when invoking the optional research extractor', { skip: !canBuildOptionalResearchFixture }, () => {
  const pdf = buildResearchPdf(configuredPython);
  const headerEnd = pdf.indexOf(Buffer.from('\n')) + 1;
  const binaryPdf = Buffer.concat([pdf.subarray(0, headerEnd), Buffer.from([0, 255, 254, 128]), pdf.subarray(headerEnd)]);
  const result = normalizeSourceInput({ name: 'binary-research-paper.pdf', fileBase64: binaryPdf.toString('base64'), mimeType: 'application/pdf' }, { pdfPythonBin: configuredPython });
  assert.equal(result.metadata.extractionMethod, 'pdfplumber');
  assert.match(result.text, /cohort study estimates/i);
});

// Optional local integration fixture. Keep developer-specific paths out of the
// distribution; set DEEPCHAT2LEARN_RESEARCH_PDF when running this test locally.
const suppliedResearchPdf = process.env.DEEPCHAT2LEARN_RESEARCH_PDF || '';
test('extracts the supplied cognitive-trajectories paper with the optional research extractor', { skip: !configuredPython || !fs.existsSync(suppliedResearchPdf) }, () => {
  const pdf = fs.readFileSync(suppliedResearchPdf);
  const result = normalizeSourceInput({ name: 'Cognitive Trajectories and Subsequent Health Status.pdf', fileBase64: pdf.toString('base64'), mimeType: 'application/pdf' }, { pdfPythonBin: configuredPython });
  assert.equal(result.metadata.extractionMethod, 'pdfplumber');
  assert.equal(result.pages, 8);
  assert.match(result.text, /cognitive trajectories/i);
  assert.ok(result.metadata.figureCount >= 1);
});

test('research PDF extraction falls back safely when the optional Python tool is unavailable', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj <</Type /Page>> endobj\nBT (Table 1. Baseline characteristics) Tj (Figure 1. Adjusted estimates) Tj ET\n%%EOF', 'latin1');
  const result = normalizeSourceInput({ name: 'research-paper.pdf', fileBase64: pdf.toString('base64'), mimeType: 'application/pdf' }, { pdfPythonBin: 'missing-python-executable-for-test' });
  assert.equal(result.metadata.extractionMethod, 'node-fallback');
  assert.match(result.text, /Table 1/);
  assert.match(result.text, /Figure 1/);
  assert.ok(Array.isArray(result.tables));
  assert.ok(Array.isArray(result.captions));
});

test('hosted Node-only PDF extraction works when Python is not configured', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj <</Type /Page>> endobj\nBT (A research finding is reported.) Tj ET\n%%EOF', 'latin1');
  const result = normalizeSourceInput({ name: 'hosted-paper.pdf', fileBase64: pdf.toString('base64'), mimeType: 'application/pdf' }, { pdfPythonBin: '' });
  assert.equal(result.metadata.extractionMethod, 'node-fallback');
  assert.match(result.text, /research finding/i);
  assert.equal(result.metadata.pythonRequired, false);
  assert.deepEqual(result.metrics, {
    bytes: pdf.length,
    words: 5,
    pages: 1,
    chunkCount: 0,
    tableCount: 0,
    figureCount: 0,
    captionCount: 0,
    extractionMethod: 'node-fallback'
  });
});

test('rejects an unsupported uploaded file type', () => {
  assert.throws(() => normalizeSourceInput({ name: 'data.exe', fileBase64: Buffer.from('no').toString('base64'), mimeType: 'application/octet-stream' }), error => error.code === 'SOURCE_TYPE_UNSUPPORTED');
});

test('rejects malformed Base64 source uploads', () => {
  assert.throws(() => normalizeSourceInput({ name: 'notes.txt', fileBase64: 'not-valid-base64?', mimeType: 'text/plain' }), error => error.code === 'SOURCE_DECODE_FAILED');
});

test('extracts text from a DOCX document body', () => {
  const docx = makeLocalZip([['word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Main idea</w:t></w:r></w:p><w:p><w:r><w:t>Supporting evidence</w:t></w:r></w:p></w:body></w:document>']]);
  const result = normalizeSourceInput({ name: 'paper.docx', fileBase64: docx.toString('base64'), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  assert.match(result.text, /Main idea/);
  assert.match(result.text, /Supporting evidence/);
  assert.equal(result.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(result.warnings.length, 1);
});

test('normalizeSourceInput preserves DOCX paragraph sections in pageMap metadata', () => {
  const docx = makeLocalZip([['word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Introduction section</w:t></w:r></w:p><w:p><w:r><w:t>Methods section</w:t></w:r></w:p></w:body></w:document>']]);
  const result = normalizeSourceInput({ name: 'paper.docx', fileBase64: docx.toString('base64'), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  assert.equal(result.pageMap.length, 2);
  assert.equal(result.pageMap[0].section, 'Section 1');
  assert.equal(result.pageMap[1].section, 'Section 2');
  assert.match(result.text.slice(result.pageMap[0].start, result.pageMap[0].end), /Introduction section/);
  assert.match(result.text.slice(result.pageMap[1].start, result.pageMap[1].end), /Methods section/);
});

test('normalizeSourceInput preserves explicit pasted-text page boundaries', () => {
  const result = normalizeSourceInput({ name: 'notes.txt', text: 'First page idea.\fSecond page evidence.' });
  assert.equal(result.pageMap.length, 2);
  assert.equal(result.pageMap[0].page, 1);
  assert.equal(result.pageMap[1].page, 2);
  assert.match(result.text.slice(result.pageMap[0].start, result.pageMap[0].end), /First page idea/);
  assert.match(result.text.slice(result.pageMap[1].start, result.pageMap[1].end), /Second page evidence/);
});

test('ingestSource preserves extraction warnings and metadata while reporting uploaded status and source metrics', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj <</Type /Page>> endobj\n2 0 obj <</Type /Page>> endobj\nBT (Main idea) Tj ET\n%%EOF', 'latin1');
  const result = ingestSource({
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    fileBase64: pdf.toString('base64')
  }, {
    limits: {
      maxFileBytes: 20_000_000,
      maxCombinedBytes: 50_000_000,
      maxPages: 300,
      maxWords: 150_000,
      maxPastedCharacters: 200_000
    }
  });
  assert.equal(result.status, 'uploaded');
  assert.equal(result.pages, 2);
  assert.equal(result.words, 2);
  assert.equal(result.warnings.length, 2);
  assert.equal(result.metadata.pageCount, 2);
  assert.equal(result.mimeType, 'application/pdf');
  assert.deepEqual(result.metrics, {
    bytes: pdf.length,
    words: 2,
    pages: 2,
    chunkCount: 0,
    tableCount: 0,
    figureCount: 0,
    captionCount: 0,
    extractionMethod: 'node-fallback'
  });
});

test('ingestSource rejects oversized pasted text with measured and configured limits', () => {
  assert.throws(() => ingestSource({
    name: 'notes.md',
    text: 'x'.repeat(25)
  }, {
    limits: {
      maxFileBytes: 20_000_000,
      maxCombinedBytes: 50_000_000,
      maxPages: 300,
      maxWords: 150_000,
      maxPastedCharacters: 20
    }
  }), error => {
    assert.equal(error.code, 'SOURCE_LIMIT');
    assert.equal(error.details.limitName, 'maxPastedCharacters');
    assert.equal(error.details.measuredValue, 25);
    assert.equal(error.details.configuredLimit, 20);
    return true;
  });
});

test('normalizeSourceInput rejects oversized uploaded files with failed status details', () => {
  assert.throws(() => normalizeSourceInput({
    name: 'tiny.txt',
    mimeType: 'text/plain',
    fileBase64: Buffer.from('123456789', 'utf8').toString('base64')
  }, {
    limits: {
      maxFileBytes: 8,
      maxCombinedBytes: 50_000_000,
      maxPages: 300,
      maxWords: 150_000,
      maxPastedCharacters: 200_000
    }
  }), error => {
    assert.equal(error.code, 'SOURCE_LIMIT');
    assert.equal(error.details.status, 'failed');
    assert.equal(error.details.limitName, 'maxFileBytes');
    assert.equal(error.details.measuredValue, 9);
    assert.equal(error.details.configuredLimit, 8);
    return true;
  });
});

test('ingestSource rejects oversized page counts with failed status details', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj <</Type /Page>> endobj\n2 0 obj <</Type /Page>> endobj\nBT (Main idea) Tj ET\n%%EOF', 'latin1');
  assert.throws(() => ingestSource({
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    fileBase64: pdf.toString('base64')
  }, {
    limits: {
      maxFileBytes: 20_000_000,
      maxCombinedBytes: 50_000_000,
      maxPages: 1,
      maxWords: 150_000,
      maxPastedCharacters: 200_000
    }
  }), error => {
    assert.equal(error.code, 'SOURCE_LIMIT');
    assert.equal(error.details.status, 'failed');
    assert.equal(error.details.limitName, 'maxPages');
    assert.equal(error.details.measuredValue, 2);
    assert.equal(error.details.configuredLimit, 1);
    return true;
  });
});

test('ingestSource rejects oversized word counts with failed status details', () => {
  assert.throws(() => ingestSource({
    name: 'notes.txt',
    text: 'one two three four five'
  }, {
    limits: {
      maxFileBytes: 20_000_000,
      maxCombinedBytes: 50_000_000,
      maxPages: 300,
      maxWords: 4,
      maxPastedCharacters: 200_000
    }
  }), error => {
    assert.equal(error.code, 'SOURCE_LIMIT');
    assert.equal(error.details.status, 'failed');
    assert.equal(error.details.limitName, 'maxWords');
    assert.equal(error.details.measuredValue, 5);
    assert.equal(error.details.configuredLimit, 4);
    return true;
  });
});
