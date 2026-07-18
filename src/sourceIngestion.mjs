import { HttpError } from './store.mjs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { getSourceLimits } from './config.mjs';

const MAX_EMBEDDED_FIGURE_BYTES = 1_000_000;
const MAX_PDF_TABLES = 50;
const MAX_PDF_CAPTIONS = 200;

function recordLifecycle(recorder, event) {
  try { recorder?.record?.(event); } catch { /* optional diagnostics must never affect ingestion */ }
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function countWords(text) {
  return (String(text).match(/\S+/g) || []).length;
}

function countPdfPages(buffer) {
  const matches = Buffer.from(buffer).toString('latin1').match(/\/Type\s*\/Page\b/g);
  return matches?.length || null;
}

function inferExtractionMethod({ mimeType, metadata = {} }) {
  if (metadata.extractionMethod === 'pdfplumber') return 'python-enhanced';
  if (metadata.extractionMethod === 'node-fallback') return 'node-fallback';
  if (mimeType === 'application/pdf') return 'node-fallback';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx-text';
  return 'text-direct';
}

function buildSourceMetrics({ byteCount, words, pages, mimeType, metadata = {}, chunkCount = 0 }) {
  return {
    bytes: byteCount,
    words,
    pages,
    chunkCount,
    tableCount: Number(metadata.tableCount || 0),
    figureCount: Number(metadata.figureCount || 0),
    captionCount: Number(metadata.captionCount || 0),
    extractionMethod: inferExtractionMethod({ mimeType, metadata })
  };
}

function buildPageMapFromSegments(segments, { defaultSectionPrefix = 'Section' } = {}) {
  const pageMap = [];
  let cursor = 0;
  const text = segments.map(segment => segment.text).filter(Boolean).join('\n');
  for (const [index, segment] of segments.entries()) {
    if (!segment.text) continue;
    const start = cursor;
    const end = start + segment.text.length;
    pageMap.push({
      page: segment.page ?? index + 1,
      section: segment.section ?? `${defaultSectionPrefix} ${index + 1}`,
      start,
      end
    });
    cursor = end + 1;
  }
  return { text, pageMap };
}

function createSourceLimitError({ limitName, measuredValue, configuredLimit, message }) {
  const error = new HttpError(413, message, 'SOURCE_LIMIT');
  error.details = { status: 'failed', limitName, measuredValue, configuredLimit };
  return error;
}

function decodePdfLiteral(value) {
  return value.replace(/\\([\\()nrt])/g, (_, escaped) => ({ '\\': '\\', '(': '(', ')': ')', n: '\n', r: '\r', t: '\t' }[escaped] || escaped))
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function decodeXmlText(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity.toLowerCase() === 'amp') return '&';
    if (entity.toLowerCase() === 'lt') return '<';
    if (entity.toLowerCase() === 'gt') return '>';
    if (entity.toLowerCase() === 'quot') return '"';
    if (entity.toLowerCase() === 'apos') return "'";
    const value = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : '';
  });
}

export function extractDocxText(buffer) {
  const bytes = Buffer.from(buffer);
  let offset = 0;
  let documentXml = null;
  while (offset + 30 <= bytes.length) {
    const signature = bytes.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const uncompressedSize = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    if (flags & 0x08) throw new HttpError(422, 'This DOCX uses an unsupported archive layout. Try saving it again and re-uploading.', 'DOCX_EXTRACTION_FAILED');
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = bytes.toString('utf8', nameStart, nameStart + nameLength);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw new HttpError(422, 'This DOCX could not be read.', 'DOCX_EXTRACTION_FAILED');
    if (name === 'word/document.xml') {
      try { documentXml = method === 0 ? bytes.subarray(dataStart, dataEnd) : method === 8 ? inflateRawSync(bytes.subarray(dataStart, dataEnd)) : null; } catch { throw new HttpError(422, 'This DOCX could not be read.', 'DOCX_EXTRACTION_FAILED'); }
      if (!documentXml) throw new HttpError(422, 'This DOCX uses an unsupported compression method.', 'DOCX_EXTRACTION_FAILED');
      break;
    }
    offset = dataEnd;
  }
  if (!documentXml) return '';
  const xml = documentXml.toString('utf8');
  const paragraphs = xml.split(/<w:p(?:\s[^>]*)?>/i).slice(1).map(paragraph => {
    const text = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gi)].map(match => decodeXmlText(match[1])).join('');
    return text.trim();
  }).filter(Boolean);
  return paragraphs.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractPdfText(buffer) {
  const pdf = Buffer.from(buffer).toString('latin1');
  const text = [];
  const literalPattern = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  for (const match of pdf.matchAll(literalPattern)) text.push(decodePdfLiteral(match[1]));
  const arrayPattern = /\[((?:\\.|[^\]])*)\]\s*TJ/g;
  for (const match of pdf.matchAll(arrayPattern)) {
    for (const part of match[1].matchAll(/\(((?:\\.|[^\\)])*)\)/g)) text.push(decodePdfLiteral(part[1]));
  }
  return text.join(' ').replace(/\s+/g, ' ').trim();
}

export function extractPdfFigures(buffer) {
  const bytes = Buffer.from(buffer);
  const pdf = bytes.toString('latin1');
  const pageCount = countPdfPages(bytes);
  const figures = [];
  const objectPattern = /(\d+)\s+\d+\s+obj\b([\s\S]*?)(?:endobj\b|$)/g;
  for (const match of pdf.matchAll(objectPattern)) {
    const body = match[2];
    if (!/\/Subtype\s*\/Image\b/.test(body)) continue;
    const readNumber = key => {
      const value = body.match(new RegExp(`/${key}\\s+(-?\\d+(?:\\.\\d+)?)`));
      return value ? Number(value[1]) : null;
    };
    const filterMatch = body.match(/\/Filter\s+(?:\[\s*)?\/(\w+)/);
    const filter = filterMatch?.[1] || null;
    const mimeType = filter === 'DCTDecode'
      ? 'image/jpeg'
      : filter === 'JPXDecode'
        ? 'image/jp2'
        : filter === 'CCITTFaxDecode'
          ? 'image/tiff'
          : 'application/octet-stream';
    const declaredLength = readNumber('Length');
    const figure = {
      figureId: `figure-${figures.length + 1}`,
      objectNumber: Number(match[1]),
      page: pageCount === 1 ? 1 : null,
      mimeType,
      filter,
      width: readNumber('Width'),
      height: readNumber('Height'),
      byteLength: declaredLength,
      extractionStatus: 'metadata_only'
    };
    const streamMatch = /(?:^|\r?\n)stream(?:\r?\n|\r|\n)/.exec(body);
    const bodyOffset = match.index + match[0].indexOf(body);
    if (streamMatch && Number.isInteger(declaredLength) && declaredLength > 0 && declaredLength <= MAX_EMBEDDED_FIGURE_BYTES && bodyOffset >= 0) {
      const dataStart = bodyOffset + streamMatch.index + streamMatch[0].length;
      const dataEnd = dataStart + declaredLength;
      if (dataEnd <= bytes.length) {
        figure.dataBase64 = bytes.subarray(dataStart, dataEnd).toString('base64');
        figure.extractionStatus = 'bytes_extracted';
      }
    }
    figures.push(figure);
  }
  return figures;
}

function extractPdfCaptions(text, pageMap = []) {
  const matches = [...String(text || '').matchAll(/(Table|Tab\.|Figure|Fig\.|Exhibit)\s+([0-9A-Za-z]+)\b/gi)];
  return matches.slice(0, MAX_PDF_CAPTIONS).map((match, index) => {
    const start = match.index || 0;
    const nextStart = matches[index + 1]?.index ?? String(text || '').length;
    const raw = String(text || '').slice(start, nextStart).split(/\r?\n/)[0].trim();
    const prefix = match[1].toLowerCase();
    const kind = prefix === 'table' || prefix === 'tab.' ? 'table' : prefix === 'exhibit' ? 'exhibit' : 'figure';
    const page = pageMap.find(item => start >= item.start && start < item.end)?.page ?? null;
    return { kind, label: `${match[1]} ${match[2]}`, page, text: raw };
  });
}

function runPdfResearchExtractor(buffer, pythonBin) {
  if (!pythonBin) return { data: null, warning: 'Python was not detected or configured; using the Node-only PDF extractor.' };
  try {
    const scriptPath = fileURLToPath(new URL('./pdf_extract.py', import.meta.url));
    const result = spawnSync(pythonBin, [scriptPath], {
      input: Buffer.from(buffer),
      encoding: 'utf8',
      maxBuffer: 12 * 1024 * 1024,
      timeout: 15_000,
      windowsHide: true
    });
    if (result.error || result.status !== 0 || !result.stdout) return { data: null, warning: 'Python PDF extraction was unavailable; using the Node-only PDF extractor.' };
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed.pages) || typeof parsed.pageCount !== 'number') return { data: null, warning: 'Python PDF extraction returned incomplete results; using the Node-only PDF extractor.' };
    return { data: {
      pageCount: parsed.pageCount,
      pages: parsed.pages.slice(0, 500).map(page => ({ page: page.page ?? null, text: String(page.text || '') })),
      tables: Array.isArray(parsed.tables) ? parsed.tables.slice(0, MAX_PDF_TABLES) : [],
      captions: Array.isArray(parsed.captions) ? parsed.captions.slice(0, MAX_PDF_CAPTIONS) : []
    }, warning: null };
  } catch {
    return { data: null, warning: 'Python PDF extraction failed; using the Node-only PDF extractor.' };
  }
}

function mergePdfResearchArtifacts(research) {
  const segments = research.pages.map(page => {
    const tableText = research.tables
      .filter(table => Number(table.page) === Number(page.page))
      .map(table => `${table.caption ? `${table.caption}\n` : ''}${table.text}`)
      .filter(Boolean);
    return {
      page: page.page,
      section: null,
      text: [page.text, ...tableText].filter(Boolean).join('\n').trim()
    };
  }).filter(segment => segment.text);
  const mapped = buildPageMapFromSegments(segments, { defaultSectionPrefix: 'Page' });
  return {
    text: mapped.text,
    pageMap: mapped.pageMap.map(item => ({ ...item, section: null })),
    tables: research.tables,
    captions: research.captions
  };
}

function extractPdfTextWithPageMap(buffer) {
  const pdf = Buffer.from(buffer).toString('latin1');
  const parts = pdf.split(/(?=\/Type\s*\/Page\b)/g);
  const pageSegments = [];
  let pageNumber = 0;
  for (const part of parts) {
    if (!/\/Type\s*\/Page\b/.test(part)) continue;
    pageNumber += 1;
    const text = extractPdfText(Buffer.from(part, 'latin1'));
    if (text) pageSegments.push({ page: pageNumber, section: null, text });
  }
  if (!pageSegments.length) {
    const text = extractPdfText(buffer);
    return { text, pageMap: text ? [{ page: null, section: null, start: 0, end: text.length }] : [] };
  }
  const { text, pageMap } = buildPageMapFromSegments(pageSegments, { defaultSectionPrefix: 'Page' });
  return {
    text,
    pageMap: pageMap.map(item => ({ ...item, section: null }))
  };
}

function extractDocxTextWithPageMap(buffer) {
  const bytes = Buffer.from(buffer);
  let offset = 0;
  let documentXml = null;
  while (offset + 30 <= bytes.length) {
    const signature = bytes.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    if (flags & 0x08) throw new HttpError(422, 'This DOCX uses an unsupported archive layout. Try saving it again and re-uploading.', 'DOCX_EXTRACTION_FAILED');
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = bytes.toString('utf8', nameStart, nameStart + nameLength);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw new HttpError(422, 'This DOCX could not be read.', 'DOCX_EXTRACTION_FAILED');
    if (name === 'word/document.xml') {
      try { documentXml = method === 0 ? bytes.subarray(dataStart, dataEnd) : method === 8 ? inflateRawSync(bytes.subarray(dataStart, dataEnd)) : null; } catch { throw new HttpError(422, 'This DOCX could not be read.', 'DOCX_EXTRACTION_FAILED'); }
      if (!documentXml) throw new HttpError(422, 'This DOCX uses an unsupported compression method.', 'DOCX_EXTRACTION_FAILED');
      break;
    }
    offset = dataEnd;
  }
  if (!documentXml) return { text: '', pageMap: [] };
  const xml = documentXml.toString('utf8');
  const paragraphs = xml.split(/<w:p(?:\s[^>]*)?>/i).slice(1).map(paragraph => {
    const text = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gi)].map(match => decodeXmlText(match[1])).join('').trim();
    return text;
  }).filter(Boolean);
  const { text, pageMap } = buildPageMapFromSegments(paragraphs.map((paragraph, index) => ({
    page: null,
    section: `Section ${index + 1}`,
    text: paragraph
  })));
  return { text: text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), pageMap };
}

function buildTextPageMap(text) {
  const pages = String(text || '').split('\f').map(part => part.trim()).filter(Boolean);
  if (pages.length <= 1) return { text: String(text || '').trim(), pageMap: [{ page: null, section: null, start: 0, end: String(text || '').trim().length }] };
  const { text: normalizedText, pageMap } = buildPageMapFromSegments(pages.map((page, index) => ({
    page: index + 1,
    section: null,
    text: page
  })), { defaultSectionPrefix: 'Page' });
  return { text: normalizedText, pageMap: pageMap.map(item => ({ ...item, section: null })) };
}

export function normalizeSourceInput({ name, text, fileBase64, mimeType }, options = {}) {
  const limits = { ...getSourceLimits(), ...(options.limits || {}) };
  const safeName = String(name || 'source-material').slice(0, 180);
  if (typeof text === 'string' && text.trim()) {
    const mappedText = buildTextPageMap(text);
    const normalizedText = mappedText.text;
    if (normalizedText.length > limits.maxPastedCharacters) {
      throw createSourceLimitError({
        limitName: 'maxPastedCharacters',
        measuredValue: normalizedText.length,
        configuredLimit: limits.maxPastedCharacters,
        message: `Pasted source text exceeds the configured maxPastedCharacters limit (${normalizedText.length}/${limits.maxPastedCharacters}).`
      });
    }
    const bytes = Buffer.byteLength(normalizedText, 'utf8');
    return {
      name: safeName,
      text: normalizedText,
      mimeType: mimeType || 'text/plain',
      hash: hash(Buffer.from(normalizedText, 'utf8')),
      warnings: [],
      byteCount: bytes,
      pages: null,
      words: countWords(normalizedText),
      metadata: { pageCount: mappedText.pageMap.filter(item => item.page !== null).length || null, sectionCount: mappedText.pageMap.filter(item => item.section).length },
      pageMap: mappedText.pageMap,
      metrics: buildSourceMetrics({
        byteCount: bytes,
        words: countWords(normalizedText),
        pages: null,
        mimeType: mimeType || 'text/plain',
        metadata: { pageCount: mappedText.pageMap.filter(item => item.page !== null).length || null, sectionCount: mappedText.pageMap.filter(item => item.section).length }
      })
    };
  }
  if (typeof fileBase64 !== 'string' || !fileBase64) throw new HttpError(400, 'Provide pasted text or a supported source file.', 'SOURCE_TEXT_REQUIRED');
  const encoded = fileBase64.trim();
  if (encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new HttpError(400, 'The uploaded source could not be decoded.', 'SOURCE_DECODE_FAILED');
  let bytes;
  try { bytes = Buffer.from(encoded, 'base64'); } catch { throw new HttpError(400, 'The uploaded source could not be decoded.', 'SOURCE_DECODE_FAILED'); }
  if (!bytes.length) throw new HttpError(400, 'The uploaded source is empty.', 'SOURCE_EMPTY');
  if (bytes.length > limits.maxFileBytes) {
    throw createSourceLimitError({
      limitName: 'maxFileBytes',
      measuredValue: bytes.length,
      configuredLimit: limits.maxFileBytes,
      message: `Uploaded source file exceeds the configured maxFileBytes limit (${bytes.length}/${limits.maxFileBytes}).`
    });
  }
  const type = mimeType || 'application/octet-stream';
  if (type === 'application/pdf' || /\.pdf$/i.test(safeName)) {
    const researchResult = runPdfResearchExtractor(bytes, options.pdfPythonBin || process.env.DEEPCHAT2LEARN_PYTHON_BIN);
    const research = researchResult.data;
    const extracted = research ? mergePdfResearchArtifacts(research) : extractPdfTextWithPageMap(bytes);
    const captions = research?.captions || extractPdfCaptions(extracted.text, extracted.pageMap);
    const tables = research?.tables || [];
    const figureCaptions = captions.filter(caption => caption.kind === 'figure');
    const rawFigures = extractPdfFigures(bytes);
    const figures = figureCaptions.length === rawFigures.length
      ? rawFigures.map((figure, index) => ({ ...figure, page: figure.page ?? figureCaptions[index].page, caption: figureCaptions[index].text }))
      : rawFigures;
    if (!extracted.text) throw new HttpError(422, 'This PDF did not contain extractable text. Try a text-based PDF or paste the text instead.', 'PDF_EXTRACTION_EMPTY');
    const pages = countPdfPages(bytes);
    const figureBytesExtracted = figures.filter(figure => figure.extractionStatus === 'bytes_extracted').length;
    const tableCaptionCount = captions.filter(caption => caption.kind === 'table').length;
    const warnings = [researchResult.warning].filter(Boolean);
    if (tableCaptionCount && !tables.length) warnings.push(`This PDF appears to include ${tableCaptionCount} table caption${tableCaptionCount === 1 ? '' : 's'}, but the table contents could not be extracted. Check the original PDF for table details.`);
    warnings.push(figures.length
      ? (figureBytesExtracted
        ? `PDF text and ${figureBytesExtracted} embedded figures or figure asset${figureBytesExtracted === 1 ? '' : 's'} were detected. Visual figure interpretation is unavailable, so scanned pages, charts, and figure meaning may still need manual review.`
        : 'PDF text was extracted and figure placeholders were detected, but the figure content could not be safely pulled out. Visual figure interpretation is unavailable, so scanned pages, charts, and figure meaning may still need manual review.')
      : 'PDF text was extracted with page mapping, but scanned pages and complex layouts may still be incomplete.');
    const metadata = {
      pageCount: pages,
      sectionCount: extracted.pageMap.filter(item => item.section).length,
      figureCount: figures.length,
      figureBytesExtracted,
      tableCount: tables.length,
      captionCount: captions.length,
      extractionMethod: research ? 'pdfplumber' : 'node-fallback',
      pythonAvailable: Boolean(research),
      pythonRequired: false,
      figures,
      tables,
      captions
    };
    return {
      name: safeName,
      text: extracted.text,
      mimeType: 'application/pdf',
      hash: hash(bytes),
      warnings,
      byteCount: bytes.length,
      pages,
      words: countWords(extracted.text),
      metadata,
      figures,
      tables,
      captions,
      pageMap: extracted.pageMap,
      metrics: buildSourceMetrics({
        byteCount: bytes.length,
        words: countWords(extracted.text),
        pages,
        mimeType: 'application/pdf',
        metadata
      })
    };
  }
  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/i.test(safeName)) {
    const extracted = extractDocxTextWithPageMap(bytes);
    if (!extracted.text) throw new HttpError(422, 'This DOCX did not contain extractable text. Try pasting the text instead.', 'DOCX_EXTRACTION_EMPTY');
    const metadata = { pageCount: null, sectionCount: extracted.pageMap.length, tableCount: 0, figureCount: 0, captionCount: 0 };
    return {
      name: safeName,
      text: extracted.text,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      hash: hash(bytes),
      warnings: ['DOCX extraction is text-only; tables, images, and complex layouts may be incomplete.'],
      byteCount: bytes.length,
      pages: null,
      words: countWords(extracted.text),
      metadata,
      pageMap: extracted.pageMap,
      metrics: buildSourceMetrics({
        byteCount: bytes.length,
        words: countWords(extracted.text),
        pages: null,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        metadata
      })
    };
  }
  if (type.startsWith('text/') || /\.(txt|md)$/i.test(safeName)) {
    const extracted = buildTextPageMap(bytes.toString('utf8'));
    const metadata = { pageCount: extracted.pageMap.filter(item => item.page !== null).length || null, sectionCount: extracted.pageMap.filter(item => item.section).length, tableCount: 0, figureCount: 0, captionCount: 0 };
    return {
      name: safeName,
      text: extracted.text,
      mimeType: type,
      hash: hash(bytes),
      warnings: [],
      byteCount: bytes.length,
      pages: null,
      words: countWords(extracted.text),
      metadata,
      pageMap: extracted.pageMap,
      metrics: buildSourceMetrics({
        byteCount: bytes.length,
        words: countWords(extracted.text),
        pages: null,
        mimeType: type,
        metadata
      })
    };
  }
  throw new HttpError(415, 'Supported source files are PDF, DOCX, TXT, and Markdown.', 'SOURCE_TYPE_UNSUPPORTED');
}

export function ingestSource(input, options = {}) {
  const normalized = normalizeSourceInput(input, options);
  const limits = { ...getSourceLimits(), ...(options.limits || {}) };
  if (normalized.words > limits.maxWords) {
    throw createSourceLimitError({
      limitName: 'maxWords',
      measuredValue: normalized.words,
      configuredLimit: limits.maxWords,
      message: `Extracted source text exceeds the configured maxWords limit (${normalized.words}/${limits.maxWords}).`
    });
  }
  if (normalized.pages !== null && normalized.pages > limits.maxPages) {
    throw createSourceLimitError({
      limitName: 'maxPages',
      measuredValue: normalized.pages,
      configuredLimit: limits.maxPages,
      message: `Source page count exceeds the configured maxPages limit (${normalized.pages}/${limits.maxPages}).`
    });
  }
  const result = {
    status: 'uploaded',
    ...normalized,
    chunks: [],
    metrics: buildSourceMetrics({
      byteCount: normalized.byteCount,
      words: normalized.words,
      pages: normalized.pages,
      mimeType: normalized.mimeType,
      metadata: normalized.metadata,
      chunkCount: 0
    })
  };
  recordLifecycle(options.lifecycleRecorder, {
    event: 'source.extraction.completed',
    sessionId: options.sessionId,
    mode: options.mode || 'source',
    status: result.status,
    sourceCount: options.sourceCount
  });
  return result;
}
