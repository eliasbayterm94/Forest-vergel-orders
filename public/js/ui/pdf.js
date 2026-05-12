// Shipment PDF generator — client-side via jsPDF + autoTable (CDN).
// The shipment payload comes from /api/shipments-list and already has
// the lots → assignments → order shape we need.

import { fmtKg, fmtDate } from './format.js';

// Brand colors as RGB tuples (jsPDF wants triplets).
const NAVY        = [27, 32, 61];
const NAVY_DARK   = [12, 12, 11];
const YELLOW      = [231, 226, 68];
const INK_700     = [42, 42, 40];
const INK_500     = [90, 90, 85];
const SAND        = [232, 232, 226];
const CREAM       = [245, 244, 238];

function ensureLib() {
  // jsPDF UMD bundle attaches to window.jspdf
  if (!(window.jspdf && window.jspdf.jsPDF)) {
    throw new Error('jsPDF no está cargado todavía. Recarga la página.');
  }
  return window.jspdf.jsPDF;
}

/**
 * Generate and download the despacho PDF.
 * @param {object} shipment  shape from /api/shipments-list
 */
export function generateShipmentPdf(shipment) {
  const jsPDF = ensureLib();
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });   // 612 × 792 pt

  const W = doc.internal.pageSize.getWidth();
  const M = 40;        // margin

  // ── Header band (navy with yellow logo + brand) ────────────────
  doc.setFillColor(...NAVY_DARK);
  doc.rect(0, 0, W, 70, 'F');

  // Yellow F square
  doc.setFillColor(...YELLOW);
  doc.roundedRect(M, 18, 36, 36, 6, 6, 'F');
  doc.setTextColor(...NAVY_DARK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('F', M + 18, 43, { align: 'center' });

  // Brand text
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(255, 255, 255);
  doc.text('FOREST  ↔  EL VERGEL', M + 50, 32);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(231, 226, 68);
  doc.text('Despacho de café verde', M + 50, 46);

  // Shipment code (right side)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...YELLOW);
  doc.text(shipment.shipment_code || '—', W - M, 32, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text(`Fecha: ${fmtDate(shipment.shipment_date)}`, W - M, 48, { align: 'right' });

  // ── Summary strip ──────────────────────────────────────────────
  let y = 90;
  doc.setFillColor(...CREAM);
  doc.roundedRect(M, y, W - M * 2, 44, 6, 6, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...INK_500);

  const cellW = (W - M * 2) / 4;
  const stats = [
    ['LOTES',      String(shipment.totals?.lot_count ?? shipment.lots.length)],
    ['PEDIDOS',    String(shipment.totals?.order_count ?? '—')],
    ['KG VERDE',   fmtKg(shipment.totals?.kg_green ?? 0)],
    ['ASIGNADOS',  fmtKg(shipment.totals?.kg_green_allocated ?? 0)],
  ];
  stats.forEach(([label, value], i) => {
    const cx = M + cellW * i + cellW / 2;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...INK_500);
    doc.text(label, cx, y + 16, { align: 'center' });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...NAVY);
    doc.text(value, cx, y + 33, { align: 'center' });
  });
  y += 60;

  if (shipment.notes) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(...INK_500);
    const split = doc.splitTextToSize('Notas: ' + shipment.notes, W - M * 2);
    doc.text(split, M, y);
    y += split.length * 12 + 8;
  }

  // ── Per-lot sections ───────────────────────────────────────────
  shipment.lots.forEach((lot) => {
    if (y > 700) { doc.addPage(); y = 40; }

    // Lot header
    doc.setFillColor(...NAVY);
    doc.roundedRect(M, y, W - M * 2, 28, 4, 4, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...YELLOW);
    doc.text(lot.bache_code || lot.lot_code || '—', M + 12, y + 18);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(255, 255, 255);
    doc.text(lot.reference_name || '—', M + 110, y + 18);
    doc.setFontSize(9);
    doc.setTextColor(149, 181, 206);
    const kgInShipment = Number(lot.kg_green_in_shipment ?? lot.kg_green_actual ?? lot.kg_green_expected ?? 0);
    doc.text(`${lot.process_type || ''} · ${fmtKg(kgInShipment)}`, W - M - 12, y + 18, { align: 'right' });

    y += 36;

    // Lot meta line
    const metaParts = [];
    if (lot.processing_stage) metaParts.push(`Etapa inicial: ${lot.processing_stage}`);
    if (lot.kg_dried_output != null) metaParts.push(`Peso seco: ${fmtKg(lot.kg_dried_output)}`);
    if (lot.factor_rendimiento != null) metaParts.push(`Factor: ${lot.factor_rendimiento}`);
    if (lot.varieties && lot.varieties.length) metaParts.push(`Variedades: ${lot.varieties.map(v=>v.name).join(', ')}`);
    if (metaParts.length) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...INK_500);
      const split = doc.splitTextToSize(metaParts.join('   ·   '), W - M * 2);
      doc.text(split, M, y);
      y += split.length * 10 + 6;
    }

    // Partials in this shipment (only when not shipping the whole lot)
    // Renderizamos los parciales como tabla autoTable — antes era texto
    // libre con bullets y resultaba dificil de leer cuando habia varios.
    const partialsHere = lot.partials_in_shipment || [];
    if (partialsHere.length > 0) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(...INK_700);
      doc.text('Parciales incluidos en este despacho:', M, y);
      y += 8;
      doc.autoTable({
        startY: y,
        margin: { left: M, right: M },
        head: [['Parcial', 'kg seco', 'Factor', 'kg verde']],
        body: partialsHere.map((p) => [
          `Parcial ${p.parcial_letter}`,
          { content: fmtKg(p.kg_dried), styles: { halign: 'right' } },
          { content: String(p.factor_rendimiento), styles: { halign: 'right' } },
          { content: fmtKg(p.kg_green_yield), styles: { halign: 'right', fontStyle: 'bold' } },
        ]),
        styles: { font: 'helvetica', fontSize: 9, cellPadding: 4, textColor: INK_700, lineColor: SAND, lineWidth: 0.5 },
        headStyles: { fillColor: CREAM, textColor: INK_500, fontStyle: 'bold', fontSize: 7 },
        alternateRowStyles: { fillColor: [251, 251, 248] },
        columnStyles: {
          0: { fontStyle: 'bold' },
          1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' },
        },
      });
      y = doc.lastAutoTable.finalY + 8;
    }

    // Assignments table — pedido + cliente + tipo + contrato + region + entrega + kg
    if (lot.assignments && lot.assignments.length > 0) {
      doc.autoTable({
        startY: y,
        margin: { left: M, right: M },
        head: [['Pedido', 'Cliente', 'Tipo', 'Contrato', 'Región', 'Entrega', 'kg verde']],
        body: lot.assignments.map((a) => {
          const o = a.order || {};
          return [
            o.order_code || '—',
            o.client_name || '—',
            o.order_type || '—',
            o.contract_code || '—',
            (o.regions && o.regions.length > 0) ? o.regions.join(', ') : '—',
            o.max_delivery_date ? fmtDate(o.max_delivery_date) : '—',
            { content: fmtKg(a.kg_green_allocated), styles: { halign: 'right', fontStyle: 'bold' } },
          ];
        }),
        styles: {
          font: 'helvetica', fontSize: 9, cellPadding: 5, textColor: INK_700,
          lineColor: SAND, lineWidth: 0.5,
        },
        headStyles: {
          fillColor: CREAM, textColor: INK_500,
          fontStyle: 'bold', fontSize: 7,
        },
        alternateRowStyles: { fillColor: [251, 251, 248] },
        columnStyles: {
          0: { cellWidth: 70, fontStyle: 'bold' },
          6: { cellWidth: 60, halign: 'right' },
        },
      });
      y = doc.lastAutoTable.finalY + 14;
    } else {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9);
      doc.setTextColor(...INK_500);
      doc.text('— sin asignaciones —', M, y);
      y += 18;
    }
  });

  // ── Footer (signatures) ────────────────────────────────────────
  if (y > 700) { doc.addPage(); y = 40; }
  y += 30;
  doc.setDrawColor(...SAND);
  doc.setLineWidth(0.5);
  doc.line(M, y, M + 220, y);
  doc.line(W - M - 220, y, W - M, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...INK_500);
  doc.text('Despacha (El Vergel)', M, y + 12);
  doc.text('Recibe (Forest)', W - M - 220, y + 12);

  doc.setFontSize(7);
  doc.setTextColor(...INK_500);
  doc.text(
    `Generado: ${new Date().toLocaleString('es-CO')}  ·  Forest Production Bridge`,
    W / 2, doc.internal.pageSize.getHeight() - 20, { align: 'center' },
  );

  doc.save(`${shipment.shipment_code || 'despacho'}.pdf`);
}
