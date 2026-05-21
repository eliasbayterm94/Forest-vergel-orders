// Shipment PDF generator — client-side via jsPDF + autoTable (CDN).
// El payload viene de /api/shipments-list con campos de destino,
// conductor y por bache (codigo_trilladora, codigo_mezcla, num_sacos).
//
// Estructura del PDF:
//   1. Header con código del despacho.
//   2. Datos de remisión: destino + conductor (cédula/nombre/placa).
//   3. Tabla principal — una línea por bache (o por partial si
//      partials_merged=false): Bache | Cód. Trilladora | Cód. Mezcla |
//      Variedad | Proceso | kg seco | Factor | # Sacos.
//   4. Totales: # lotes, total kg seco, total lonas.
//   5. Por cada bache: lista de asignaciones (pedido / cliente).

import { fmtKg, fmtDate } from './format.js';

const NAVY        = [27, 32, 61];
const NAVY_DARK   = [12, 12, 11];
const YELLOW      = [231, 226, 68];
const INK_700     = [42, 42, 40];
const INK_500     = [90, 90, 85];
const SAND        = [232, 232, 226];
const CREAM       = [245, 244, 238];

function ensureLib() {
  if (!(window.jspdf && window.jspdf.jsPDF)) {
    throw new Error('jsPDF no está cargado todavía. Recarga la página.');
  }
  return window.jspdf.jsPDF;
}

export function generateShipmentPdf(shipment) {
  const jsPDF = ensureLib();
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });

  const W = doc.internal.pageSize.getWidth();
  const M = 40;

  // ── Header band ──────────────────────────────────────────────
  doc.setFillColor(...NAVY_DARK);
  doc.rect(0, 0, W, 70, 'F');
  doc.setFillColor(...YELLOW);
  doc.roundedRect(M, 18, 36, 36, 6, 6, 'F');
  doc.setTextColor(...NAVY_DARK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('F', M + 18, 43, { align: 'center' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(255, 255, 255);
  doc.text('FOREST  ↔  EL VERGEL', M + 50, 32);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(231, 226, 68);
  doc.text('Despacho de café', M + 50, 46);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...YELLOW);
  doc.text(shipment.shipment_code || '—', W - M, 32, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text(`Fecha: ${fmtDate(shipment.shipment_date)}`, W - M, 48, { align: 'right' });

  // ── Datos de remisión: destino + conductor ──────────────────
  let y = 90;
  doc.setFillColor(...CREAM);
  doc.roundedRect(M, y, W - M * 2, 72, 6, 6, 'F');

  const destLabel = shipment.destino_kind === 'Otro'
    ? (shipment.destino_other || 'Otro')
    : (shipment.destino_kind || '—');
  const remisionRows = [
    ['Destino', destLabel],
    ['Conductor', shipment.driver_name || '—'],
    ['Cédula', shipment.driver_cedula || '—'],
    ['Placas', shipment.driver_placas || '—'],
  ];
  const colW = (W - M * 2) / 4;
  remisionRows.forEach(([label, value], i) => {
    const cx = M + colW * i + 12;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...INK_500);
    doc.text(label.toUpperCase(), cx, y + 16);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...NAVY);
    const txt = doc.splitTextToSize(String(value), colW - 16);
    doc.text(txt, cx, y + 32);
  });
  if (shipment.notes) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(...INK_500);
    const split = doc.splitTextToSize('Notas: ' + shipment.notes, W - M * 2 - 16);
    doc.text(split, M + 8, y + 58);
  }
  y += 88;

  // ── Tabla principal por bache (o por partial si separate) ──
  // Construye las filas: si partials_merged=true (default), una línea
  // por bache con kg sumado. Si false, una línea por partial.
  const rows = [];
  let totalSeco = 0;
  let totalSacos = 0;
  for (const lot of shipment.lots || []) {
    const variedad = (lot.varieties || []).map((v) => v.name).join(', ') || '—';
    const baseLabel = lot.is_blend
      ? `[MZ] ${lot.blend_code || lot.bache_code || lot.lot_code || '—'}`
      : (lot.bache_code || lot.lot_code || '—');

    const partialsHere = lot.partials_in_shipment || [];
    if (lot.whole_lot_in_shipment || partialsHere.length === 0) {
      const kgSeco = Number(lot.kg_dried_output || 0);
      const sacos  = Number(lot.num_sacos || 0);
      totalSeco  += kgSeco;
      totalSacos += sacos;
      rows.push([
        baseLabel,
        lot.codigo_trilladora || '—',
        lot.codigo_mezcla     || '—',
        variedad,
        lot.process_type || '—',
        { content: fmtKg(kgSeco), styles: { halign: 'right' } },
        { content: lot.factor_rendimiento != null ? String(lot.factor_rendimiento) : '—', styles: { halign: 'right' } },
        { content: sacos > 0 ? String(sacos) : '—', styles: { halign: 'right' } },
      ]);
    } else if (lot.partials_merged !== false) {
      // Una sola fila agrupando todos los parciales del bache.
      const kgSeco = partialsHere.reduce((s, p) => s + Number(p.kg_dried || 0), 0);
      const sacos  = Number(lot.num_sacos || 0);
      const factorAvg = (() => {
        const w = partialsHere.reduce((s, p) => s + Number(p.factor_rendimiento || 0) * Number(p.kg_dried || 0), 0);
        return kgSeco > 0 ? (Math.round((w / kgSeco) * 100) / 100).toString() : '—';
      })();
      totalSeco  += kgSeco;
      totalSacos += sacos;
      const partialLetters = partialsHere.map((p) => p.parcial_letter).join('+');
      rows.push([
        `${baseLabel}  · ${partialLetters}`,
        lot.codigo_trilladora || '—',
        lot.codigo_mezcla     || '—',
        variedad,
        lot.process_type || '—',
        { content: fmtKg(kgSeco), styles: { halign: 'right' } },
        { content: factorAvg, styles: { halign: 'right' } },
        { content: sacos > 0 ? String(sacos) : '—', styles: { halign: 'right' } },
      ]);
    } else {
      // Separar: una fila por partial.
      for (const p of partialsHere) {
        const kgSeco = Number(p.kg_dried || 0);
        const sacos  = Number(p.num_sacos || 0);
        totalSeco  += kgSeco;
        totalSacos += sacos;
        rows.push([
          `${baseLabel}-${p.parcial_letter}`,
          p.codigo_trilladora || '—',
          p.codigo_mezcla     || '—',
          variedad,
          lot.process_type || '—',
          { content: fmtKg(kgSeco), styles: { halign: 'right' } },
          { content: String(p.factor_rendimiento || '—'), styles: { halign: 'right' } },
          { content: sacos > 0 ? String(sacos) : '—', styles: { halign: 'right' } },
        ]);
      }
    }
  }

  // Fila TOTAL al final
  rows.push([
    { content: `TOTAL · ${rows.length} línea(s)`, colSpan: 5, styles: { fontStyle: 'bold', fillColor: CREAM } },
    { content: fmtKg(totalSeco), styles: { halign: 'right', fontStyle: 'bold', fillColor: CREAM } },
    { content: '', styles: { fillColor: CREAM } },
    { content: String(totalSacos), styles: { halign: 'right', fontStyle: 'bold', fillColor: CREAM } },
  ]);

  doc.autoTable({
    startY: y,
    margin: { left: M, right: M },
    head: [['Bache', 'Cód. Trilladora', 'Cód. Mezcla', 'Variedad', 'Proceso', 'kg seco', 'Factor', '# Sacos']],
    body: rows,
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 4, textColor: INK_700, lineColor: SAND, lineWidth: 0.5 },
    headStyles: { fillColor: NAVY, textColor: YELLOW, fontStyle: 'bold', fontSize: 7 },
    alternateRowStyles: { fillColor: [251, 251, 248] },
    columnStyles: {
      0: { cellWidth: 68, fontStyle: 'bold' },
      1: { cellWidth: 70 }, 2: { cellWidth: 60 },
      3: { cellWidth: 78 }, 4: { cellWidth: 50 },
      5: { cellWidth: 56, halign: 'right' },
      6: { cellWidth: 40, halign: 'right' },
      7: { cellWidth: 40, halign: 'right' },
    },
  });
  y = doc.lastAutoTable.finalY + 6;

  // Totales-strip (refuerzo visual)
  doc.setFillColor(...NAVY);
  doc.roundedRect(M, y, W - M * 2, 36, 4, 4, 'F');
  const totStats = [
    ['# LOTES',       String(shipment.totals?.lot_count ?? shipment.lots.length)],
    ['TOTAL KG SECO', fmtKg(totalSeco)],
    ['TOTAL LONAS',   String(totalSacos)],
    ['PEDIDOS',       String(shipment.totals?.order_count ?? '—')],
  ];
  const tCellW = (W - M * 2) / 4;
  totStats.forEach(([label, value], i) => {
    const cx = M + tCellW * i + tCellW / 2;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(149, 181, 206);
    doc.text(label, cx, y + 14, { align: 'center' });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...YELLOW);
    doc.text(value, cx, y + 28, { align: 'center' });
  });
  y += 50;

  // ── Asignaciones por bache (pedidos / clientes) ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...INK_700);
  doc.text('ASIGNACIONES POR BACHE', M, y);
  y += 8;

  shipment.lots.forEach((lot) => {
    if (y > 720) { doc.addPage(); y = 40; }
    const label = lot.is_blend
      ? `[MZ] ${lot.blend_code || lot.bache_code || '—'}`
      : (lot.bache_code || lot.lot_code || '—');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...NAVY);
    doc.text(`${label}  ·  ${lot.reference_name || ''}`, M, y);
    y += 4;

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
        styles: { font: 'helvetica', fontSize: 8, cellPadding: 3, textColor: INK_700, lineColor: SAND, lineWidth: 0.5 },
        headStyles: { fillColor: CREAM, textColor: INK_500, fontStyle: 'bold', fontSize: 7 },
        alternateRowStyles: { fillColor: [251, 251, 248] },
        columnStyles: { 0: { cellWidth: 64, fontStyle: 'bold' }, 6: { cellWidth: 56, halign: 'right' } },
      });
      y = doc.lastAutoTable.finalY + 8;
    } else {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8);
      doc.setTextColor(...INK_500);
      doc.text('— sin asignaciones —', M, y + 12);
      y += 22;
    }
  });

  // ── Firmas + footer ──
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
