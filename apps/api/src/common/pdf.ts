/**
 * Minimal dependency-free PDF writer for invoice rendering (FR-6.2).
 * Produces a valid single-or-multi-page PDF 1.4 document with Helvetica text.
 */

interface PdfLine {
  text: string;
  size?: number;
  bold?: boolean;
  gapBefore?: number;
}

const PAGE_W = 595.28; // A4 in points
const PAGE_H = 841.89;
const MARGIN_X = 56;
const TOP_Y = PAGE_H - 64;
const BOTTOM_LIMIT = 64;

function ascii(input: string): string {
  return input
    .replace(/€/g, 'EUR ')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/–|—/g, '-')
    .replace(/[^\x20-\x7E\n]/g, '');
}

function escapeText(text: string): string {
  return ascii(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function renderSimplePdf(lines: PdfLine[]): Buffer {
  const pages: string[][] = [];
  let ops: string[] = [];
  let y = TOP_Y;

  const newPage = () => {
    if (ops.length) pages.push(ops);
    ops = [];
    y = TOP_Y;
  };

  for (const line of lines) {
    const size = line.size ?? 10;
    const gap = line.gapBefore ?? 6;
    y -= gap + size;
    if (y < BOTTOM_LIMIT) newPage();
    const font = line.bold ? '/F2' : '/F1';
    ops.push(`BT ${font} ${size} Tf ${MARGIN_X} ${y.toFixed(2)} Td (${escapeText(line.text)}) Tj ET`);
  }
  newPage();

  const objects: string[] = [];
  const pageObjIds: number[] = [];
  // Object numbering: 1 catalog, 2 pages, 3 F1, 4 F2, then per-page: content+page pair.
  let nextId = 5;
  for (let i = 0; i < pages.length; i++) {
    const contentId = nextId++;
    const pageId = nextId++;
    pageObjIds.push(pageId);
    const content = pages[i].join('\n');
    objects[contentId] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
  }

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pageObjIds.map((id) => `${id} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageObjIds.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    if (!objects[id]) continue;
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(out, 'latin1');
  const maxId = objects.length;
  out += `xref\n0 ${maxId}\n`;
  out += '0000000000 65535 f \n';
  for (let id = 1; id < maxId; id++) {
    out += offsets[id]
      ? `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
      : '0000000000 65535 f \n';
  }
  out += `trailer\n<< /Size ${maxId} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

export interface InvoicePdfData {
  number: string | null;
  status: string;
  currency: string;
  issueDate: Date | null;
  dueDate: Date | null;
  clientName: string;
  lines: Array<{ label: string; quantity: any; unitPrice: any; taxRate: any; lineTotal: any }>;
  subtotal: any;
  taxTotal: any;
  total: any;
  amountPaid: any;
}

export function renderInvoicePdf(inv: InvoicePdfData): Buffer {
  const money = (v: any) => `${inv.currency} ${Number(v).toFixed(2)}`;
  const date = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '-');
  const doc: PdfLine[] = [
    { text: 'BusinessHub', size: 20, bold: true, gapBefore: 0 },
    { text: 'Invoice', size: 14, bold: true, gapBefore: 12 },
    { text: `Number: ${inv.number ?? '(unassigned)'}`, gapBefore: 14 },
    { text: `Status: ${inv.status}` },
    { text: `Issue date: ${date(inv.issueDate)}` },
    { text: `Due date: ${date(inv.dueDate)}` },
    { text: `Bill to: ${inv.clientName}`, gapBefore: 12 },
    { text: '', gapBefore: 8 },
    { text: 'Description                              Qty        Unit price   Tax %   Total', bold: true },
  ];
  for (const l of inv.lines) {
    const label = l.label.length > 36 ? `${l.label.slice(0, 33)}...` : l.label.padEnd(40);
    doc.push({
      text: `${label} ${String(l.quantity)}   ${money(l.unitPrice).padEnd(14)} ${String(l.taxRate)}%   ${money(l.lineTotal)}`,
    });
  }
  doc.push({ text: '', gapBefore: 10 });
  doc.push({ text: `Subtotal: ${money(inv.subtotal)}`, bold: true });
  doc.push({ text: `Tax: ${money(inv.taxTotal)}`, bold: true });
  doc.push({ text: `TOTAL DUE: ${money(inv.total)}`, size: 13, bold: true, gapBefore: 8 });
  doc.push({ text: `Amount paid: ${money(inv.amountPaid)}`, gapBefore: 6 });
  const balance = Number(inv.total) - Number(inv.amountPaid);
  doc.push({ text: `Balance: ${inv.currency} ${balance.toFixed(2)}`, bold: true });
  return renderSimplePdf(doc);
}
