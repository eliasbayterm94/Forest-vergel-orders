// Shipment PDFs — client-side via jsPDF + autoTable (CDN).
//
// Dos documentos separados:
//
//   generateShipmentPdf(shipment)
//     → Remisión que va a la trilladora. Solo data del envío: destino,
//       conductor, tabla por línea (bache, cód. trilladora, cód.
//       mezcla, variedad, proceso, kg seco, factor, # sacos), totales
//       y firmas. NO incluye asignaciones de pedidos para no
//       confundir a la trilladora sobre dónde va cada bache.
//
//   generateShipmentAssignmentsPdf(shipment)
//     → Documento interno de Forest. Para cada bache lista las
//       asignaciones a pedidos (cliente, contrato, región, entrega,
//       kg verde).

import { fmtKg, fmtDate } from './format.js';

const NAVY        = [27, 32, 61];
const NAVY_DARK   = [12, 12, 11];
const YELLOW      = [231, 226, 68];
const INK_700     = [42, 42, 40];
const INK_500     = [90, 90, 85];
const INK_300     = [154, 154, 147];
const SAND        = [232, 232, 226];
const CREAM       = [245, 244, 238];
const OLIVE       = [122, 138, 87];   // fermentation
const AMBER       = [221, 174, 62];   // drying
const SLATE       = [126, 158, 193];  // resting
const COFFEE      = [93, 139, 102];   // ready / closed
const CHERRY_RED  = [168, 53, 28];    // cherry reception

// '#rrggbb' → [r,g,b] o null si no es un hex válido.
function hexToRgbArr(hex) {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex || '');
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function ensureLib() {
  if (!(window.jspdf && window.jspdf.jsPDF)) {
    throw new Error('jsPDF no está cargado todavía. Recarga la página.');
  }
  return window.jspdf.jsPDF;
}

export function generateShipmentPdf(shipment) {
  const jsPDF = ensureLib();
  // Horizontal: 11 columnas (incluye Sacos/Lonas/Empaque/Observaciones
  // sin sacrificar Variedad, que es vital para la trilladora).
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'landscape' });

  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
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
  doc.text('FOREST · EL VERGEL', M + 50, 32);
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
  doc.roundedRect(M, y, W - M * 2, 84, 6, 6, 'F');

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
    const cx = M + colW * i + colW / 2;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...INK_500);
    doc.text(label.toUpperCase(), cx, y + 18, { align: 'center' });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...NAVY);
    const txt = doc.splitTextToSize(String(value), colW - 12);
    doc.text(txt, cx, y + 34, { align: 'center' });
  });
  if (shipment.notes) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(...INK_500);
    const split = doc.splitTextToSize('Notas: ' + shipment.notes, W - M * 2 - 16);
    doc.text(split, M + 8, y + 72);
  }
  y += 100;

  // ── Tabla principal por bache (o por partial si separate) ──
  // Construye las filas: si partials_merged=true (default), una línea
  // por bache con kg sumado. Si false, una línea por partial.
  const rows = [];
  const rowColors = [];   // color de cinta por fila (hex o null)
  let totalSeco = 0;
  let totalSacos = 0;
  let totalLonas = 0;
  let totalGP = 0;
  let totalBolsas = 0;
  const empaqueLabel = (e) => e === 'grainpro' ? 'GRAIN PRO' : e === 'bolsa' ? 'BOLSA' : '—';
  const pushRow = (cells, src) => {
    const sacos = Number(src.num_sacos || 0);
    const lonas = Number(src.num_lonas || 0);
    if (src.empaque_interior === 'grainpro') totalGP += sacos + lonas;
    else if (src.empaque_interior === 'bolsa') totalBolsas += sacos + lonas;
    totalSacos += sacos;
    totalLonas += lonas;
    rows.push(cells);
    rowColors.push(src.color_cinta || null);
  };
  for (const lot of shipment.lots || []) {
    const variedad = (lot.varieties || []).map((v) => v.name).join(', ') || '—';
    let baseLabel = lot.is_blend
      ? `[MZ] ${lot.blend_code || lot.bache_code || lot.lot_code || '—'}`
      : (lot.bache_code || lot.lot_code || '—');
    // División del bache al despachar: mismo No. con identificador P.
    if (lot.split_label) baseLabel = `${baseLabel}-${lot.split_label}`;

    const partialsHere = lot.partials_in_shipment || [];
    if (lot.whole_lot_in_shipment || partialsHere.length === 0) {
      // Despacho whole-lot o partial-by-kg: el kg realmente sacado
      // está en lot.kg_dried_shipped (lo guarda shipments-list desde
      // shipment_lots.kg_dried_shipped). Sin ese campo (shipments
      // viejos) caemos al total del bache como fallback.
      const kgSeco = Number(lot.kg_dried_shipped ?? lot.kg_dried_output ?? 0);
      totalSeco += kgSeco;
      // Despacho parcial con saldo aún en bodega: la trilladora ve el
      // kg que va en ESTE camión y el total del bache como referencia.
      const kgTotalBache = Number(lot.kg_dried_output || 0);
      const esParcial = lot.lot_status === 'Ready' && kgTotalBache > 0 && kgSeco < kgTotalBache - 0.01;
      const kgCell = esParcial ? `${fmtKg(kgSeco)}\nde ${fmtKg(kgTotalBache)} kg` : fmtKg(kgSeco);
      pushRow([
        baseLabel,
        lot.codigo_trilladora || '—',
        lot.codigo_mezcla     || '—',
        variedad,
        lot.process_type || '—',
        { content: kgCell, styles: { halign: 'right' } },
        { content: lot.factor_rendimiento != null ? String(lot.factor_rendimiento) : '—', styles: { halign: 'right' } },
        { content: Number(lot.num_sacos || 0) > 0 ? String(lot.num_sacos) : '—', styles: { halign: 'right' } },
        { content: Number(lot.num_lonas || 0) > 0 ? String(lot.num_lonas) : '—', styles: { halign: 'right' } },
        empaqueLabel(lot.empaque_interior),
        lot.observaciones || '',
      ], lot);
    } else if (lot.partials_merged !== false) {
      // Una sola fila agrupando todos los parciales del bache.
      const kgSeco = partialsHere.reduce((s, p) => s + Number(p.kg_dried || 0), 0);
      const factorAvg = (() => {
        const w = partialsHere.reduce((s, p) => s + Number(p.factor_rendimiento || 0) * Number(p.kg_dried || 0), 0);
        return kgSeco > 0 ? (Math.round((w / kgSeco) * 100) / 100).toString() : '—';
      })();
      totalSeco += kgSeco;
      const partialLetters = partialsHere.map((p) => p.parcial_letter).join('+');
      pushRow([
        `${baseLabel}  · ${partialLetters}`,
        lot.codigo_trilladora || '—',
        lot.codigo_mezcla     || '—',
        variedad,
        lot.process_type || '—',
        { content: fmtKg(kgSeco), styles: { halign: 'right' } },
        { content: factorAvg, styles: { halign: 'right' } },
        { content: Number(lot.num_sacos || 0) > 0 ? String(lot.num_sacos) : '—', styles: { halign: 'right' } },
        { content: Number(lot.num_lonas || 0) > 0 ? String(lot.num_lonas) : '—', styles: { halign: 'right' } },
        empaqueLabel(lot.empaque_interior),
        lot.observaciones || '',
      ], lot);
    } else {
      // Separar: una fila por partial (empaque/color/obs vienen por línea).
      for (const p of partialsHere) {
        const kgSeco = Number(p.kg_dried || 0);
        totalSeco += kgSeco;
        pushRow([
          `${baseLabel}-${p.parcial_letter}`,
          p.codigo_trilladora || '—',
          p.codigo_mezcla     || '—',
          variedad,
          lot.process_type || '—',
          { content: fmtKg(kgSeco), styles: { halign: 'right' } },
          { content: String(p.factor_rendimiento || '—'), styles: { halign: 'right' } },
          { content: Number(p.num_sacos || 0) > 0 ? String(p.num_sacos) : '—', styles: { halign: 'right' } },
          { content: Number(p.num_lonas || 0) > 0 ? String(p.num_lonas) : '—', styles: { halign: 'right' } },
          empaqueLabel(p.empaque_interior),
          p.observaciones || '',
        ], p);
      }
    }
  }

  // Fila TOTAL al final
  const dataRowCount = rows.length;
  rows.push([
    { content: `TOTAL · ${dataRowCount} línea(s)`, colSpan: 5, styles: { fontStyle: 'bold', fillColor: CREAM } },
    { content: fmtKg(totalSeco), styles: { halign: 'right', fontStyle: 'bold', fillColor: CREAM } },
    { content: '', styles: { fillColor: CREAM } },
    { content: String(totalSacos), styles: { halign: 'right', fontStyle: 'bold', fillColor: CREAM } },
    { content: String(totalLonas), styles: { halign: 'right', fontStyle: 'bold', fillColor: CREAM } },
    { content: `GP ${totalGP} · Bol ${totalBolsas}`, colSpan: 2, styles: { fontStyle: 'bold', fillColor: CREAM, fontSize: 7 } },
  ]);

  doc.autoTable({
    startY: y,
    margin: { left: M, right: M },
    head: [['Bache', 'Cód. Trilladora', 'Cód. Mezcla', 'Variedad', 'Proceso', 'kg seco', 'Factor', 'Sacos', 'Lonas', 'Empaque', 'Observaciones']],
    body: rows,
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 4, textColor: INK_700, lineColor: SAND, lineWidth: 0.5 },
    headStyles: { fillColor: NAVY, textColor: YELLOW, fontStyle: 'bold', fontSize: 7 },
    alternateRowStyles: { fillColor: [251, 251, 248] },
    columnStyles: {
      0: { cellWidth: 66, fontStyle: 'bold' },
      1: { cellWidth: 62 }, 2: { cellWidth: 54 },
      3: { cellWidth: 74 }, 4: { cellWidth: 46 },
      5: { cellWidth: 52, halign: 'right' },
      6: { cellWidth: 38, halign: 'right' },
      7: { cellWidth: 32, halign: 'right' },
      8: { cellWidth: 32, halign: 'right' },
      9: { cellWidth: 52 },
      // 10 (Observaciones) flexible
    },
    // Pinta cada fila con el color de cinta del lote; el texto pasa a
    // blanco automáticamente sobre colores oscuros.
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      if (data.row.index >= dataRowCount) return;   // fila TOTAL
      const hex = rowColors[data.row.index];
      if (!hex) return;
      const rgb = hexToRgbArr(hex);
      if (!rgb) return;
      data.cell.styles.fillColor = rgb;
      const luminance = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
      if (luminance < 140) data.cell.styles.textColor = [255, 255, 255];
    },
  });
  y = doc.lastAutoTable.finalY + 6;

  // Totales-strip (refuerzo visual)
  doc.setFillColor(...NAVY);
  doc.roundedRect(M, y, W - M * 2, 36, 4, 4, 'F');
  const totStats = [
    // Se cuenta por LÍNEA de la remisión (cada parcial/división es una
    // línea), no por bache: un bache separado en varias líneas cuenta
    // cada una.
    ['# LÍNEAS',      String(dataRowCount)],
    ['TOTAL KG SECO', fmtKg(totalSeco)],
    ['SACOS',         String(totalSacos)],
    ['LONAS',         String(totalLonas)],
    ['GRAIN PRO',     String(totalGP)],
    ['BOLSAS PLÁST.', String(totalBolsas)],
  ];
  const tCellW = (W - M * 2) / 6;
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

  // ── Firmas + footer ──
  if (y > H - 130) { doc.addPage(); y = 40; }
  y += 30;
  doc.setDrawColor(...SAND);
  doc.setLineWidth(0.5);
  doc.line(M, y, M + 220, y);
  doc.line(W - M - 220, y, W - M, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...INK_500);
  doc.text('Despacha (El Vergel)', M, y + 12);
  doc.text('Recibe (trilladora)', W - M - 220, y + 12);

  doc.setFontSize(7);
  doc.setTextColor(...INK_500);
  doc.text(
    `Remisión · Generado: ${new Date().toLocaleString('es-CO')}  ·  Forest Production Bridge`,
    W / 2, doc.internal.pageSize.getHeight() - 20, { align: 'center' },
  );

  doc.save(`remision-${shipment.shipment_code || 'despacho'}.pdf`);
}

// ── PDF de PREPARACIÓN (borrador para bodega) ──────────────────
// Hoja de alistamiento marcada BORRADOR. Muestra lo necesario para
// que bodega prepare el despacho: bache, códigos de trilladora/mezcla
// (si ya se conocen), variedad, proceso, kg a alistar y empaque. Si
// el bache trae color de cinta, la fila se pinta de ese color. SIN
// firmas oficiales — no es una remisión.
export function generateShipmentPrepPdf(shipment) {
  const jsPDF = ensureLib();
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'landscape' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;

  // ── Header band (naranja borrador, no navy) ──
  const DRAFT = [176, 98, 22];   // ámbar/naranja para diferenciar
  doc.setFillColor(...DRAFT);
  doc.rect(0, 0, W, 70, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(255, 255, 255);
  doc.text('FOREST · EL VERGEL', M, 30);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(255, 236, 200);
  doc.text('BORRADOR · PREPARACIÓN DE BODEGA', M, 46);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('No es remisión oficial · para alistar el despacho', M, 58);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(255, 255, 255);
  doc.text(shipment.shipment_code || 'BORRADOR', W - M, 30, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Fecha: ${fmtDate(shipment.shipment_date)}`, W - M, 48, { align: 'right' });

  let y = 86;
  const destLabel = shipment.destino_kind === 'Otro'
    ? (shipment.destino_other || 'Otro') : (shipment.destino_kind || '— (por definir) —');
  doc.setFillColor(...CREAM);
  doc.roundedRect(M, y, W - M * 2, 30, 5, 5, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...INK_500);
  doc.text('DESTINO', M + 10, y + 12);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...NAVY);
  doc.text(destLabel, M + 10, y + 25);
  y += 44;

  // Filas: una por bache/parcial con kg a alistar.
  const rows = [];
  const rowColors = [];   // color de cinta por fila (hex o null)
  let totalSeco = 0, totalSacos = 0, totalLonas = 0;
  const empaqueLabel = (e) => e === 'grainpro' ? 'Grain Pro' : e === 'bolsa' ? 'Bolsa plást.' : '—';
  const pushRow = (label, src, kg, variedad, proceso) => {
    totalSeco += Number(kg || 0);
    totalSacos += Number(src.num_sacos || 0);
    totalLonas += Number(src.num_lonas || 0);
    const empaque = [
      Number(src.num_sacos || 0) ? `${src.num_sacos} sacos` : null,
      Number(src.num_lonas || 0) ? `${src.num_lonas} lonas` : null,
      src.empaque_interior ? empaqueLabel(src.empaque_interior) : null,
    ].filter(Boolean).join(' · ') || '—';
    rows.push([
      label,
      src.codigo_trilladora || '—',
      src.codigo_mezcla || '—',
      variedad || '—', proceso || '—',
      { content: fmtKg(kg), styles: { halign: 'right' } },
      empaque, src.observaciones || '',
    ]);
    rowColors.push(src.color_cinta || null);
  };
  for (const lot of shipment.lots || []) {
    const variedad = (lot.varieties || []).map((v) => v.name).join(', ') || '—';
    let baseLabel = lot.is_blend
      ? `[MZ] ${lot.blend_code || lot.bache_code || lot.lot_code || '—'}`
      : (lot.bache_code || lot.lot_code || '—');
    if (lot.split_label) baseLabel = `${baseLabel}-${lot.split_label}`;
    const partialsHere = lot.partials_in_shipment || [];
    if (lot.whole_lot_in_shipment || partialsHere.length === 0) {
      pushRow(baseLabel, lot, Number(lot.kg_dried_shipped ?? lot.kg_dried_output ?? 0),
        variedad, lot.process_type);
    } else if (lot.partials_merged !== false) {
      const kg = partialsHere.reduce((s, p) => s + Number(p.kg_dried || 0), 0);
      pushRow(`${baseLabel} · ${partialsHere.map((p) => p.parcial_letter).join('+')}`,
        lot, kg, variedad, lot.process_type);
    } else {
      for (const p of partialsHere) {
        pushRow(`${baseLabel}-${p.parcial_letter}`, p, Number(p.kg_dried || 0), variedad, lot.process_type);
      }
    }
  }
  const dataRowCount = rows.length;
  rows.push([
    { content: `TOTAL · ${dataRowCount} línea(s) a alistar`, colSpan: 5, styles: { fontStyle: 'bold', fillColor: CREAM } },
    { content: fmtKg(totalSeco), styles: { halign: 'right', fontStyle: 'bold', fillColor: CREAM } },
    { content: `${totalSacos} sacos · ${totalLonas} lonas`, colSpan: 2, styles: { fontStyle: 'bold', fillColor: CREAM, fontSize: 8 } },
  ]);

  doc.autoTable({
    startY: y,
    margin: { left: M, right: M },
    head: [['Bache', 'Cód. Trilladora', 'Cód. Mezcla', 'Variedad', 'Proceso', 'kg a alistar', 'Empaque', 'Observaciones']],
    body: rows,
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 5, textColor: INK_700, lineColor: SAND, lineWidth: 0.5 },
    headStyles: { fillColor: DRAFT, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
    alternateRowStyles: { fillColor: [251, 251, 248] },
    columnStyles: {
      0: { cellWidth: 84, fontStyle: 'bold' },
      1: { cellWidth: 74 }, 2: { cellWidth: 66 },
      3: { cellWidth: 96 }, 4: { cellWidth: 54 },
      5: { cellWidth: 62, halign: 'right' },
      6: { cellWidth: 104 },
      // 7 (Observaciones) flexible
    },
    // Pinta cada fila con el color de cinta del bache (si lo tiene);
    // el texto pasa a blanco sobre colores oscuros.
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      if (data.row.index >= dataRowCount) return;   // fila TOTAL
      const rgb = hexToRgbArr(rowColors[data.row.index]);
      if (!rgb) return;
      data.cell.styles.fillColor = rgb;
      const luminance = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
      if (luminance < 140) data.cell.styles.textColor = [255, 255, 255];
    },
  });
  y = doc.lastAutoTable.finalY + 20;

  // Marca de agua diagonal BORRADOR.
  doc.saveGraphicsState();
  doc.setGState(new doc.GState({ opacity: 0.08 }));
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(90);
  doc.setTextColor(...DRAFT);
  doc.text('BORRADOR', W / 2, H / 2, { align: 'center', angle: 30 });
  doc.restoreGraphicsState();

  // Checkbox de preparado + firma de bodega.
  if (y > H - 90) { doc.addPage(); y = 40; }
  doc.setDrawColor(...INK_300);
  doc.setLineWidth(0.8);
  doc.rect(M, y, 12, 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...INK_700);
  doc.text('Despacho preparado y verificado por bodega', M + 20, y + 10);
  y += 40;
  doc.setDrawColor(...SAND);
  doc.line(M, y, M + 220, y);
  doc.setFontSize(8);
  doc.setTextColor(...INK_500);
  doc.text('Preparó (bodega)', M, y + 12);

  doc.setFontSize(7);
  doc.text(
    `Preparación (borrador) · Generado: ${new Date().toLocaleString('es-CO')}  ·  Forest Production Bridge`,
    W / 2, H - 20, { align: 'center' },
  );

  doc.save(`preparacion-${shipment.shipment_code || 'borrador'}.pdf`);
}

// ── PDF de asignaciones (documento interno de Forest) ──────────
// Mismo header que la remisión pero con sello "ASIGNACIONES — USO
// INTERNO" para no confundirse. Por cada bache lista las
// asignaciones a pedidos.
export function generateShipmentAssignmentsPdf(shipment) {
  const jsPDF = ensureLib();
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });

  const W = doc.internal.pageSize.getWidth();
  const M = 40;

  // Header
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
  doc.text('FOREST · EL VERGEL', M + 50, 32);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(231, 226, 68);
  doc.text('Asignaciones del despacho · Uso interno', M + 50, 46);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...YELLOW);
  doc.text(shipment.shipment_code || '—', W - M, 32, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text(`Fecha: ${fmtDate(shipment.shipment_date)}`, W - M, 48, { align: 'right' });

  let y = 90;

  // Banda con destino (solo referencia, sin conductor)
  const destLabel = shipment.destino_kind === 'Otro'
    ? (shipment.destino_other || 'Otro')
    : (shipment.destino_kind || '—');
  doc.setFillColor(...CREAM);
  doc.roundedRect(M, y, W - M * 2, 28, 4, 4, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...INK_500);
  doc.text('DESTINO', M + 12, y + 12);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...NAVY);
  doc.text(destLabel, M + 12, y + 22);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...INK_500);
  doc.text(
    `${shipment.totals?.lot_count ?? shipment.lots.length} lote(s)  ·  ${shipment.totals?.order_count ?? '—'} pedido(s)  ·  ${fmtKg(shipment.totals?.kg_green || 0)} verde`,
    W - M - 12, y + 18, { align: 'right' },
  );
  y += 44;

  // Asignaciones por bache. Las asignaciones son del LOTE: si el
  // bache va dividido en P1/P2, solo se imprime una vez.
  const seenLots = new Set();
  shipment.lots.forEach((lot) => {
    if (seenLots.has(lot.id)) return;
    seenLots.add(lot.id);
    if (y > 720) { doc.addPage(); y = 40; }
    const label = lot.is_blend
      ? `[MZ] ${lot.blend_code || lot.bache_code || '—'}`
      : (lot.bache_code || lot.lot_code || '—');

    // Strip navy con bache y referencia
    doc.setFillColor(...NAVY);
    doc.roundedRect(M, y, W - M * 2, 22, 3, 3, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...YELLOW);
    doc.text(label, M + 10, y + 15);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(255, 255, 255);
    doc.text(lot.reference_name || '—', M + 110, y + 15);
    // Suma sobre todas las líneas P del bache en este despacho.
    const kgInShipment = shipment.lots
      .filter((g) => g.id === lot.id)
      .reduce((s, g) => s + Number(g.kg_green_in_shipment ?? g.kg_green_actual ?? g.kg_green_expected ?? 0), 0);
    doc.setFontSize(8);
    doc.setTextColor(149, 181, 206);
    doc.text(`${lot.process_type || ''} · ${fmtKg(kgInShipment)}`, W - M - 10, y + 15, { align: 'right' });
    y += 26;

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
        styles: { font: 'helvetica', fontSize: 9, cellPadding: 4, textColor: INK_700, lineColor: SAND, lineWidth: 0.5 },
        headStyles: { fillColor: CREAM, textColor: INK_500, fontStyle: 'bold', fontSize: 7 },
        alternateRowStyles: { fillColor: [251, 251, 248] },
        columnStyles: { 0: { cellWidth: 64, fontStyle: 'bold' }, 6: { cellWidth: 60, halign: 'right' } },
      });
      y = doc.lastAutoTable.finalY + 10;
    } else {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9);
      doc.setTextColor(...INK_500);
      doc.text('— sin asignaciones —', M, y + 12);
      y += 22;
    }
  });

  // Footer
  doc.setFontSize(7);
  doc.setTextColor(...INK_500);
  doc.text(
    `Asignaciones · Uso interno · Generado: ${new Date().toLocaleString('es-CO')}`,
    W / 2, doc.internal.pageSize.getHeight() - 20, { align: 'center' },
  );

  doc.save(`asignaciones-${shipment.shipment_code || 'despacho'}.pdf`);
}

// ── PDF de inventario de bodega (Punto Final) ──────────────────
// Lista los lotes Listos actualmente en bodega con sus kg seco/verde,
// factor, humedad y días en bodega. Acepta los items ya enriquecidos
// de la vista Punto Final (campos: bache_code, blend_code, is_blend,
// reference_name, process_type, _variety_names, kg_dried_output,
// kg_verde, factor_rendimiento, final_humidity, days_in_warehouse,
// ready_date).
export function generateInventoryPdf(items) {
  const jsPDF = ensureLib();
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'landscape' });

  const W = doc.internal.pageSize.getWidth();
  const M = 36;

  // Header band
  doc.setFillColor(...NAVY_DARK);
  doc.rect(0, 0, W, 60, 'F');
  doc.setFillColor(...YELLOW);
  doc.roundedRect(M, 14, 32, 32, 5, 5, 'F');
  doc.setTextColor(...NAVY_DARK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text('F', M + 16, 37, { align: 'center' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(255, 255, 255);
  doc.text('FOREST · EL VERGEL', M + 46, 28);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(231, 226, 68);
  doc.text('Inventario de bodega · Punto Final', M + 46, 42);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text(`Generado: ${new Date().toLocaleString('es-CO')}`, W - M, 36, { align: 'right' });

  // Totales — el seco mostrado es el DISPONIBLE en bodega (descontando
  // despachos y kg consumido en mezclas), no el producido original.
  const secoOf = (l) => Number(l.kg_dried_available != null ? l.kg_dried_available : l.kg_dried_output || 0);
  let totalSeco = 0, totalVerde = 0, totalAsig = 0, totalDisp = 0;
  const byProc = { Natural: 0, Honey: 0, Lavado: 0 };
  for (const l of items) {
    const seco = secoOf(l);
    totalSeco  += seco;
    totalVerde += Number(l.kg_verde || 0);
    totalAsig  += Number(l.kg_green_assigned || 0);
    totalDisp  += Number(l.kg_green_available || 0);
    if (byProc[l.process_type] != null) byProc[l.process_type] += seco;
  }

  let y = 76;
  doc.setFillColor(...CREAM);
  doc.roundedRect(M, y, W - M * 2, 40, 5, 5, 'F');
  const stats = [
    ['LOTES', String(items.length)],
    ['TOTAL KG SECO', fmtKg(totalSeco)],
    ['TOTAL KG VERDE', fmtKg(totalVerde)],
    ['NATURAL (seco)', fmtKg(byProc.Natural)],
    ['HONEY (seco)', fmtKg(byProc.Honey)],
    ['LAVADO (seco)', fmtKg(byProc.Lavado)],
  ];
  const cw = (W - M * 2) / stats.length;
  stats.forEach(([label, val], i) => {
    const cx = M + cw * i + cw / 2;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...INK_500);
    doc.text(label, cx, y + 15, { align: 'center' });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...NAVY);
    doc.text(val, cx, y + 31, { align: 'center' });
  });
  y += 52;

  const body = items.map((l) => {
    const code = l.is_blend
      ? `[MZ] ${l.blend_code || l.bache_code || l.lot_code || '—'}`
      : (l.bache_code || l.lot_code || '—');
    return [
      code,
      l.reference_name || '—',
      l.process_type || '—',
      (l._variety_names && l._variety_names.length ? l._variety_names.join(', ') : '—'),
      { content: fmtKg(secoOf(l)), styles: { halign: 'right' } },
      { content: fmtKg(l.kg_verde || 0), styles: { halign: 'right' } },
      { content: fmtKg(l.kg_green_assigned || 0), styles: { halign: 'right' } },
      { content: fmtKg(l.kg_green_available || 0), styles: { halign: 'right', fontStyle: 'bold' } },
      { content: l.factor_rendimiento != null ? String(l.factor_rendimiento) : '—', styles: { halign: 'right' } },
      { content: l.final_humidity != null ? `${l.final_humidity}%` : '—', styles: { halign: 'right' } },
      { content: l.days_in_warehouse == null ? '—' : `${l.days_in_warehouse}d`, styles: { halign: 'right' } },
      l.ready_date ? fmtDate(l.ready_date) : '—',
    ];
  });
  // Fila total
  body.push([
    { content: `TOTAL · ${items.length} lote(s)`, colSpan: 4, styles: { fontStyle: 'bold', fillColor: CREAM } },
    { content: fmtKg(totalSeco), styles: { halign: 'right', fontStyle: 'bold', fillColor: CREAM } },
    { content: fmtKg(totalVerde), styles: { halign: 'right', fontStyle: 'bold', fillColor: CREAM } },
    { content: fmtKg(totalAsig), styles: { halign: 'right', fontStyle: 'bold', fillColor: CREAM } },
    { content: fmtKg(totalDisp), styles: { halign: 'right', fontStyle: 'bold', fillColor: CREAM } },
    { content: '', colSpan: 4, styles: { fillColor: CREAM } },
  ]);

  doc.autoTable({
    startY: y,
    margin: { left: M, right: M },
    head: [['Bache', 'Referencia', 'Proceso', 'Variedades', 'kg seco', 'kg verde', 'Asignado v.', 'Disponible v.', 'Factor', 'Humedad', 'Días', 'Listo desde']],
    body,
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 4, textColor: INK_700, lineColor: SAND, lineWidth: 0.5 },
    headStyles: { fillColor: NAVY, textColor: YELLOW, fontStyle: 'bold', fontSize: 7 },
    alternateRowStyles: { fillColor: [251, 251, 248] },
    columnStyles: {
      0: { cellWidth: 64, fontStyle: 'bold' },
      4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' },
      7: { halign: 'right' }, 8: { halign: 'right' }, 9: { halign: 'right' }, 10: { halign: 'right' },
    },
  });

  doc.setFontSize(7);
  doc.setTextColor(...INK_500);
  doc.text(
    'Inventario de bodega · Forest Production Bridge',
    W / 2, doc.internal.pageSize.getHeight() - 16, { align: 'center' },
  );

  const stamp = new Date().toISOString().slice(0, 10);
  doc.save(`inventario-bodega-${stamp}.pdf`);
}

// ── Lot Passport (Hoja de vida) ────────────────────────────────
// Single-page A4 portrait document handed out when a lot reaches
// Punto Final. English-language, designed to look like a wine
// certificate: huge lot code, KPI grid, process journey timeline
// with one card per stage (Cherry → Fermentation → Drying →
// Resting · Cycle N → Drying — Resumed → Lot Closed), and a
// footer with a QR encoding the bache code.
//
// Blend variant: replaces the timeline with a "Component Lineage"
// section listing each parent lote with its kg seco contribution.
export function generateLotPassportPdf(lot) {
  const jsPDF = ensureLib();
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  const W = doc.internal.pageSize.getWidth();   // 595
  const H = doc.internal.pageSize.getHeight();  // 842
  const M = 36;

  const isBlend = !!lot.is_blend;
  const code = isBlend
    ? (lot.blend_code || lot.bache_code || lot.lot_code || '—')
    : (lot.bache_code || lot.lot_code || '—');

  // ── Header band ──────────────────────────────────────────────
  doc.setFillColor(...NAVY_DARK);
  doc.rect(0, 0, W, 72, 'F');
  doc.setFillColor(...YELLOW);
  doc.roundedRect(M, 22, 32, 32, 4, 4, 'F');
  doc.setTextColor(...NAVY_DARK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text('F', M + 16, 44, { align: 'center' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(255, 255, 255);
  doc.text('FOREST · EL VERGEL', M + 46, 36);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...YELLOW);
  doc.text('Lot Passport', M + 46, 48);
  // Right side
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...YELLOW);
  doc.text(
    `ISSUED  ${fmtDate(lot.ready_date || lot.delivered_date || new Date().toISOString().slice(0, 10))}`,
    W - M, 36, { align: 'right' },
  );
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(255, 255, 255);
  doc.text(
    isBlend
      ? `Blend · ${(lot.blend_components || []).length} components`
      : 'Single origin lot',
    W - M, 50, { align: 'right' },
  );

  // ── Hero card ────────────────────────────────────────────────
  let y = 92;
  const heroH = 124;
  doc.setFillColor(...CREAM);
  doc.roundedRect(M, y, W - 2 * M, heroH, 8, 8, 'F');
  doc.setDrawColor(...YELLOW);
  doc.setLineWidth(3);
  doc.line(M, y, M + 80, y);

  // Process pill (top-left)
  const procColor = processColorFor(lot.process_type);
  if (isBlend) {
    doc.setFillColor(...NAVY);
    doc.roundedRect(M + 18, y + 16, 52, 16, 8, 8, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...YELLOW);
    doc.text('BLEND', M + 44, y + 27, { align: 'center' });
  } else {
    doc.setFillColor(...procColor);
    const pillTxt = (lot.process_type || '—').toUpperCase();
    const pillW = Math.max(48, pillTxt.length * 5 + 16);
    doc.roundedRect(M + 18, y + 16, pillW, 16, 8, 8, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);
    doc.text(pillTxt, M + 18 + pillW / 2, y + 27, { align: 'center' });
  }

  // Reference name (top-right)
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...INK_500);
  doc.text('REFERENCE', W - M - 18, y + 24, { align: 'right' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...NAVY);
  doc.text(lot.reference_name || '—', W - M - 18, y + 36, { align: 'right' });

  // Huge lot code
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(48);
  doc.setTextColor(...NAVY);
  doc.text(String(code), M + 18, y + 80);

  // Subtitle (variety or components)
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...INK_700);
  const subline = isBlend
    ? `Components: ${(lot.blend_components || [])
        .map((c) => c.bache_code || c.blend_code || c.lot_code).join('  +  ')}`
    : `Variety: ${(lot.varieties || []).map((v) => v.name).join(', ') || '—'}`;
  doc.text(doc.splitTextToSize(subline, W - 2 * M - 36), M + 18, y + 98);

  // Date range
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.setTextColor(...INK_500);
  const durTxt = (lot.start_date && lot.ready_date)
    ? `${fmtDate(lot.start_date)}  to  ${fmtDate(lot.ready_date)}  ·  ${daysBetweenYmd(lot.start_date, lot.ready_date)} days end-to-end`
    : (lot.start_date ? `Started ${fmtDate(lot.start_date)}` : '—');
  doc.text(durTxt, M + 18, y + 114);

  y += heroH + 16;

  // ── KPI grid 3x2 ─────────────────────────────────────────────
  const kpis = [
    { label: 'CHERRY INPUT',   value: lot.kg_input_initial != null ? `${fmtKg(lot.kg_input_initial)} kg` : '—' },
    { label: 'DRIED OUTPUT',   value: lot.kg_dried_output != null  ? `${fmtKg(lot.kg_dried_output)} kg`  : '—' },
    { label: 'GREEN YIELD',    value: lot.kg_green_actual != null  ? `${fmtKg(lot.kg_green_actual)} kg`  : '—' },
    { label: 'YIELD FACTOR',   value: lot.factor_rendimiento != null ? String(lot.factor_rendimiento) : '—' },
    { label: 'CONVERSION',     value: lot.conversion_factor != null ? `${lot.conversion_factor}x` : '—' },
    { label: 'FINAL HUMIDITY', value: lot.final_humidity != null ? `${lot.final_humidity}%` : '—' },
  ];
  const gap = 8;
  const kpiW = (W - 2 * M - 2 * gap) / 3;
  const kpiH = 54;
  kpis.forEach((k, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = M + col * (kpiW + gap);
    const yy = y + row * (kpiH + gap);
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(...SAND);
    doc.setLineWidth(0.5);
    doc.roundedRect(x, yy, kpiW, kpiH, 4, 4, 'FD');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...INK_500);
    doc.text(k.label, x + 10, yy + 16);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(...NAVY);
    doc.text(k.value, x + 10, yy + 38);
  });
  y += 2 * kpiH + gap + 18;

  // ── Section title ───────────────────────────────────────────
  const sectionTitle = isBlend ? 'COMPONENT LINEAGE' : 'PROCESS JOURNEY';
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...NAVY);
  doc.text(sectionTitle, M, y);
  const tw = doc.getTextWidth(sectionTitle);
  doc.setDrawColor(...YELLOW);
  doc.setLineWidth(2.4);
  doc.line(M, y + 5, M + tw + 6, y + 5);
  y += 22;

  // ── Body ────────────────────────────────────────────────────
  if (isBlend) {
    drawBlendComponents(doc, lot, M, y, W, H);
  } else {
    drawProcessJourney(doc, lot, M, y, W, H);
  }

  // ── Footer (drawn once on the LAST page) ────────────────────
  drawPassportFooter(doc, code, lot, W, H, M);

  doc.save(`lot-passport-${code}.pdf`);
}

function processColorFor(p) {
  if (p === 'Natural') return [58, 111, 74];
  if (p === 'Honey')   return [221, 174, 62];
  if (p === 'Lavado')  return [126, 158, 193];
  return NAVY;
}

function daysBetweenYmd(a, b) {
  if (!a || !b) return 0;
  const da = new Date(a + 'T00:00:00Z').getTime();
  const db = new Date(b + 'T00:00:00Z').getTime();
  return Math.max(0, Math.floor((db - da) / 86400000));
}

// Builds the events used by the Process Journey timeline. Each
// event becomes one numbered card in the PDF: a colored disc
// with a step numeral, an iconic vector glyph, a title + tagline,
// and a row of pill-style metric badges.
function buildPassportEvents(lot) {
  const events = [];

  // ── Cherry Reception ───────────────────────────────────────
  if (lot.start_date) {
    const variety = (lot.varieties || []).map((v) => v.name).join(', ');
    events.push({
      kind: 'cherry',
      date: lot.start_date,
      dateLabel: fmtDate(lot.start_date),
      title: 'Cherry Reception',
      tagline: variety || 'Single variety lot',
      pills: [
        lot.kg_input_initial != null
          ? { label: 'WEIGHED IN', value: `${fmtKg(lot.kg_input_initial)} kg` }
          : null,
        { label: 'LOT STARTED', value: fmtDate(lot.start_date) },
      ].filter(Boolean),
      color: CHERRY_RED,
    });
  }

  // ── Fermentation ───────────────────────────────────────────
  if (lot.start_date) {
    const types = (lot.fermentation_types || []).join(' · ') || 'Anaerobic';
    const tanks = (lot.fermentation_tanks || []).join(', ');
    const tag = tanks ? `${types}  ·  Tanks ${tanks}` : types;

    const planH = Number(lot.fermentation_hours || 0);
    let realH = null;
    if (lot.fermentation_start_at && lot.drying_start_at) {
      const a = new Date(lot.fermentation_start_at).getTime();
      const b = new Date(lot.drying_start_at).getTime();
      if (Number.isFinite(a) && Number.isFinite(b)) realH = Math.round((b - a) / 3600000);
    }
    const pills = [];
    if (planH > 0) pills.push({ label: 'PLANNED', value: `${planH} h` });
    if (realH != null) pills.push({ label: 'ACTUAL', value: `${realH} h` });
    if (planH > 0 && realH != null) {
      const delta = realH - planH;
      pills.push({ label: 'DELTA', value: `${delta >= 0 ? '+' : ''}${delta} h` });
    }
    if (pills.length === 0) pills.push({ label: 'PHASE', value: 'Anaerobic' });

    events.push({
      kind: 'fermentation',
      date: lot.start_date,
      dateLabel: fmtDate(lot.start_date),
      title: 'Fermentation',
      tagline: tag,
      pills,
      color: OLIVE,
    });
  }

  // ── Drying — Initial Phase ─────────────────────────────────
  if (lot.drying_start_date) {
    const locs = (lot.drying_locations || []).join(', ') || 'Drying patio';
    const cycles = (lot.resting_cycles || []).slice()
      .sort((a, b) => a.cycle_number - b.cycle_number);
    const initialEnd = cycles.length > 0 ? cycles[0].start_date : lot.ready_date;
    const days = initialEnd ? daysBetweenYmd(lot.drying_start_date, initialEnd) : 0;

    events.push({
      kind: 'drying',
      date: lot.drying_start_date,
      dateLabel: fmtDate(lot.drying_start_date),
      title: cycles.length > 0 ? 'Drying — Initial Phase' : 'Drying',
      tagline: `Drying surface: ${locs}`,
      pills: [
        days > 0    ? { label: 'DURATION', value: `${days} days` } : null,
        initialEnd  ? { label: 'ENDED',    value: fmtDate(initialEnd) } : null,
      ].filter(Boolean),
      color: AMBER,
    });
  }

  // ── Resting cycles (+ Drying — Resumed inserts) ────────────
  const cycles = (lot.resting_cycles || []).slice()
    .sort((a, b) => a.cycle_number - b.cycle_number);
  cycles.forEach((c, idx) => {
    const pills = [];
    if (c.start_humidity != null) pills.push({ label: 'ENTRY', value: `${c.start_humidity}%` });
    if (c.end_humidity != null)   pills.push({ label: 'EXIT',  value: `${c.end_humidity}%` });
    if (c.start_date && c.end_date) {
      const d = daysBetweenYmd(c.start_date, c.end_date);
      pills.push({ label: 'DURATION', value: `${d} d` });
    }
    events.push({
      kind: 'resting',
      date: c.start_date,
      dateLabel: fmtDate(c.start_date),
      title: `Resting · Cycle ${c.cycle_number}`,
      tagline: c.end_date
        ? `${fmtDate(c.start_date)}  →  ${fmtDate(c.end_date)}`
        : `Started ${fmtDate(c.start_date)}`,
      pills,
      color: SLATE,
    });

    if (c.end_date && c.end_reason === 'back_to_drying') {
      const next = cycles[idx + 1];
      const resumeEnd = next ? next.start_date : lot.ready_date;
      // Marquesinas del secado RESUMIDO viven en el ciclo (drying_locations_after),
      // no en lot.drying_locations (que conserva las del secado inicial).
      const locs = (c.drying_locations_after || []).join(', ') || 'Drying patio';
      const d = (resumeEnd && c.end_date) ? daysBetweenYmd(c.end_date, resumeEnd) : 0;
      events.push({
        kind: 'drying-resumed',
        date: c.end_date,
        dateLabel: fmtDate(c.end_date),
        title: 'Drying — Resumed',
        tagline: `Drying surface: ${locs}`,
        pills: [
          d > 0      ? { label: 'DURATION', value: `${d} days` } : null,
          resumeEnd  ? { label: 'ENDED',    value: fmtDate(resumeEnd) } : null,
        ].filter(Boolean),
        color: AMBER,
      });
    }
  });

  // ── Lot Closed ─────────────────────────────────────────────
  if (lot.ready_date) {
    const pills = [];
    if (lot.kg_dried_output != null)   pills.push({ label: 'DRY',      value: `${fmtKg(lot.kg_dried_output)} kg` });
    if (lot.factor_rendimiento != null) pills.push({ label: 'FACTOR',   value: String(lot.factor_rendimiento) });
    if (lot.kg_green_actual != null)   pills.push({ label: 'GREEN',    value: `${fmtKg(lot.kg_green_actual)} kg` });
    if (lot.final_humidity != null)    pills.push({ label: 'HUMIDITY', value: `${lot.final_humidity}%` });

    const tagline = lot.start_date
      ? `${daysBetweenYmd(lot.start_date, lot.ready_date)} days end-to-end`
      : 'Lot finished and ready for milling';

    events.push({
      kind: 'closed',
      date: lot.ready_date,
      dateLabel: fmtDate(lot.ready_date),
      title: 'Lot Closed',
      tagline,
      pills,
      color: COFFEE,
    });
  }

  return events
    .map((ev, i) => ({ ev, i }))
    .sort((a, b) => {
      const da = a.ev.date || '';
      const db = b.ev.date || '';
      if (da !== db) return da < db ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.ev);
}

function drawProcessJourney(doc, lot, M, startY, W, H) {
  const events = buildPassportEvents(lot);
  if (events.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(...INK_500);
    doc.text('No events recorded.', M, startY + 10);
    return;
  }

  const cardW = W - 2 * M;
  const cardH = 70;
  const bottomLimit = H - 96;
  let y = startY;

  events.forEach((ev, i) => {
    if (y + cardH > bottomLimit) {
      doc.addPage();
      y = 60;
    }

    // Card background — white with sand border + colored left edge
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(...SAND);
    doc.setLineWidth(0.6);
    doc.roundedRect(M, y, cardW, cardH, 6, 6, 'FD');
    doc.setFillColor(...ev.color);
    doc.rect(M, y, 4, cardH, 'F');

    // Numbered disc on the left
    const discR  = 20;
    const discCx = M + 38;
    const discCy = y + cardH / 2;
    doc.setFillColor(...ev.color);
    doc.circle(discCx, discCy, discR, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(255, 255, 255);
    doc.text(String(i + 1).padStart(2, '0'), discCx, discCy + 7, { align: 'center' });

    // Stage icon to the right of the disc
    const iconCx = M + 78;
    const iconCy = discCy;
    drawStageIcon(doc, ev.kind, iconCx, iconCy, ev.color);

    // Title + date row
    const titleX = M + 100;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...NAVY);
    doc.text(ev.title.toUpperCase(), titleX, y + 22);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...INK_500);
    doc.text((ev.dateLabel || '').toUpperCase(), M + cardW - 14, y + 22, { align: 'right' });

    // Title underline accent
    doc.setDrawColor(...ev.color);
    doc.setLineWidth(1.6);
    const titleW = doc.getTextWidth(ev.title.toUpperCase());
    doc.line(titleX, y + 26, titleX + Math.min(titleW, 80), y + 26);

    // Tagline
    if (ev.tagline) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(...INK_700);
      const tagSplit = doc.splitTextToSize(ev.tagline, cardW - (titleX - M) - 24);
      doc.text(tagSplit[0] || '', titleX, y + 39);
    }

    // Pill row at the bottom
    if (ev.pills && ev.pills.length > 0) {
      drawPillRow(doc, ev.pills, titleX, y + 50, cardW - (titleX - M) - 18, ev.color);
    }

    y += cardH + 8;
  });
}

function drawPillRow(doc, pills, x, y, maxW, color) {
  let px = x;
  const pillH = 18;
  for (const p of pills) {
    // Measure value width with bold 9pt
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    const valW = doc.getTextWidth(p.value);
    // Measure label width with 6pt uppercase
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    const lblW = doc.getTextWidth(p.label);
    const pillW = Math.max(valW, lblW) + 14;

    if (px + pillW > x + maxW) break;

    doc.setFillColor(...CREAM);
    doc.setDrawColor(...SAND);
    doc.setLineWidth(0.5);
    doc.roundedRect(px, y, pillW, pillH, 9, 9, 'FD');
    // Color dot
    doc.setFillColor(...color);
    doc.circle(px + 6, y + pillH / 2, 1.8, 'F');
    // Label (tiny uppercase, top half)
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.2);
    doc.setTextColor(...INK_500);
    doc.text(p.label, px + 12, y + 7.5);
    // Value (bigger, bottom half)
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...color);
    doc.text(p.value, px + 12, y + 15);

    px += pillW + 6;
  }
}

// Simple iconic glyphs drawn with jsPDF primitives. Each one is
// roughly 18x18pt centred on (cx, cy) and uses the event color.
function drawStageIcon(doc, kind, cx, cy, color) {
  doc.setFillColor(...color);
  doc.setDrawColor(...color);

  if (kind === 'cherry') {
    // Two cherries + stem
    doc.circle(cx - 3, cy + 3, 4.5, 'F');
    doc.circle(cx + 4, cy + 4, 4.5, 'F');
    doc.setDrawColor(58, 111, 74);
    doc.setLineWidth(1.2);
    doc.line(cx - 3, cy - 1, cx + 1, cy - 8);
    doc.line(cx + 4, cy, cx + 1, cy - 8);
  } else if (kind === 'fermentation') {
    // Conical flask + bubbles
    doc.setLineWidth(1.8);
    doc.line(cx - 6, cy - 6, cx - 3, cy + 6);
    doc.line(cx + 6, cy - 6, cx + 3, cy + 6);
    doc.line(cx - 6, cy - 6, cx + 6, cy - 6);
    doc.line(cx - 3, cy + 6, cx + 3, cy + 6);
    doc.setFillColor(...color);
    doc.circle(cx - 2, cy - 10, 1.4, 'F');
    doc.circle(cx + 2, cy - 12, 1.4, 'F');
    doc.circle(cx,     cy - 15, 1.6, 'F');
  } else if (kind === 'drying' || kind === 'drying-resumed') {
    // Sun: filled disc + 8 short rays
    doc.setFillColor(...color);
    doc.circle(cx, cy, 4.5, 'F');
    doc.setLineWidth(1.6);
    for (let a = 0; a < 8; a++) {
      const rad = (a * Math.PI) / 4;
      const r1 = 7;
      const r2 = 10.5;
      doc.line(cx + Math.cos(rad) * r1, cy + Math.sin(rad) * r1,
               cx + Math.cos(rad) * r2, cy + Math.sin(rad) * r2);
    }
    if (kind === 'drying-resumed') {
      // Small refresh-arrow on top-right
      doc.setLineWidth(1.2);
      doc.line(cx + 10, cy - 10, cx + 14, cy - 6);
      doc.line(cx + 14, cy - 6,  cx + 10, cy - 6);
      doc.line(cx + 14, cy - 6,  cx + 14, cy - 10);
    }
  } else if (kind === 'resting') {
    // Crescent moon
    doc.setFillColor(...color);
    doc.circle(cx, cy, 8, 'F');
    doc.setFillColor(255, 255, 255);
    doc.circle(cx + 4, cy - 2, 7, 'F');
  } else if (kind === 'closed') {
    // Coffee cup with steam
    doc.setFillColor(...color);
    doc.roundedRect(cx - 7, cy - 3, 11, 9, 1, 1, 'F');
    doc.setLineWidth(1.5);
    doc.line(cx + 4, cy - 1, cx + 7, cy + 1);
    doc.line(cx + 7, cy + 1, cx + 4, cy + 4);
    // Steam
    doc.setLineWidth(0.9);
    doc.line(cx - 4, cy - 10, cx - 4, cy - 7);
    doc.line(cx,     cy - 12, cx,     cy - 8);
    doc.line(cx + 4, cy - 10, cx + 4, cy - 7);
  }
}

function drawBlendComponents(doc, lot, M, startY, W, H) {
  const comps = lot.blend_components || [];
  if (comps.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(...INK_500);
    doc.text('No components recorded.', M, startY + 10);
    return;
  }

  // Intro line
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(9);
  doc.setTextColor(...INK_500);
  const total = comps.reduce((s, c) => s + Number(c.kg_dried_used || 0), 0);
  doc.text(
    `${comps.length} source lots combined  ·  ${fmtKg(total)} kg total dry weight`,
    M, startY,
  );
  let y = startY + 16;

  doc.autoTable({
    startY: y,
    margin: { left: M, right: M },
    head: [['Source lot', 'Process', 'Dry weight', 'Share of blend']],
    body: comps.map((c) => {
      const kg = Number(c.kg_dried_used || 0);
      const pct = total > 0 ? Math.round((kg / total) * 1000) / 10 : 0;
      return [
        c.bache_code || c.blend_code || c.lot_code || '—',
        c.process_type || '—',
        { content: `${fmtKg(kg)} kg`, styles: { halign: 'right' } },
        { content: `${pct}%`, styles: { halign: 'right' } },
      ];
    }),
    styles: { font: 'helvetica', fontSize: 10, cellPadding: 8, textColor: INK_700, lineColor: SAND, lineWidth: 0.5 },
    headStyles: { fillColor: NAVY, textColor: YELLOW, fontStyle: 'bold', fontSize: 8 },
    alternateRowStyles: { fillColor: CREAM },
    columnStyles: {
      0: { cellWidth: 110, fontStyle: 'bold' },
      2: { halign: 'right' }, 3: { halign: 'right' },
    },
  });
}

function drawPassportFooter(doc, code, lot, W, H, M) {
  const pageCount = doc.getNumberOfPages();
  doc.setPage(pageCount);

  const fy = H - 72;
  doc.setFillColor(...NAVY_DARK);
  doc.rect(0, fy, W, 72, 'F');

  // QR (left)
  const qrSize = 56;
  const qrX = M;
  const qrY = fy + 8;
  drawQrCode(doc, code, qrX, qrY, qrSize);

  // Centre text
  const cx = qrX + qrSize + 16;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(255, 255, 255);
  doc.text('FOREST · EL VERGEL', cx, fy + 22);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...YELLOW);
  doc.text('Production Passport · Authentic Origin', cx, fy + 36);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(190, 190, 190);
  doc.text(
    `Generated ${new Date().toLocaleString('en-US')}  ·  Forest Production Bridge`,
    cx, fy + 50,
  );

  // Right: lot code label
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...YELLOW);
  doc.text('LOT', W - M, fy + 22, { align: 'right' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(255, 255, 255);
  doc.text(String(code), W - M, fy + 38, { align: 'right' });
}

// Renders the QR using qrcode-generator (loaded via CDN). Draws
// each module as a navy rect on a white background. Falls back to
// a navy square with the code printed below if the lib isn't
// available.
function drawQrCode(doc, payload, x, y, size) {
  doc.setFillColor(255, 255, 255);
  doc.rect(x, y, size, size, 'F');

  const QR = window.qrcode;
  if (typeof QR !== 'function') {
    doc.setDrawColor(...YELLOW);
    doc.setLineWidth(0.5);
    doc.rect(x, y, size, size, 'D');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(...NAVY);
    doc.text(String(payload), x + size / 2, y + size / 2 + 2, { align: 'center' });
    return;
  }

  try {
    const qr = QR(0, 'M');
    qr.addData(String(payload));
    qr.make();
    const count = qr.getModuleCount();
    const cell  = size / count;
    doc.setFillColor(...NAVY_DARK);
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          doc.rect(x + c * cell, y + r * cell, cell + 0.2, cell + 0.2, 'F');
        }
      }
    }
  } catch {
    doc.setDrawColor(...YELLOW);
    doc.setLineWidth(0.5);
    doc.rect(x, y, size, size, 'D');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(...NAVY);
    doc.text(String(payload), x + size / 2, y + size / 2 + 2, { align: 'center' });
  }
}
