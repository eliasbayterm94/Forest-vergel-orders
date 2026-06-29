// Charts SVG sin dependencias. Suficientes para los reportes
// internos (pie de proceso, barras agrupadas cereza/seco mensual,
// barras horizontales de equipos de secado). Si crecen las
// necesidades se cambia por Chart.js o similar.
//
// Las funciones devuelven un Node listo para `append`. Cada gráfico
// es responsive: usa viewBox + preserveAspectRatio para escalar a su
// contenedor.

import { el } from './el.js';
import { fmtKg } from './format.js';

const NS = 'http://www.w3.org/2000/svg';

function svg(attrs, children = []) {
  const node = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c) node.appendChild(c);
  return node;
}
function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.appendChild(c);
  if (attrs.text) node.textContent = attrs.text;
  return node;
}

// ─────────────────────────────────────────────────────────────────
// Pie chart con leyenda al lado.
//   slices: [{ label, value, color }]
//   opts: { unit, total }   unit = 'kg' default
// ─────────────────────────────────────────────────────────────────
export function pieChart(slices, opts = {}) {
  const total = opts.total != null ? opts.total
    : slices.reduce((s, x) => s + Number(x.value || 0), 0);
  const SIZE = 220;
  const R = 92;
  const CX = SIZE / 2, CY = SIZE / 2;

  let acc = 0;
  const arcs = [];
  if (total <= 0) {
    arcs.push(svgEl('circle', { cx: CX, cy: CY, r: R, fill: '#e8e8e2' }));
  } else {
    slices.forEach((s, i) => {
      const v = Number(s.value || 0);
      if (v <= 0) return;
      const startAngle = (acc / total) * 2 * Math.PI;
      acc += v;
      const endAngle = (acc / total) * 2 * Math.PI;
      const x1 = CX + R * Math.cos(startAngle - Math.PI / 2);
      const y1 = CY + R * Math.sin(startAngle - Math.PI / 2);
      const x2 = CX + R * Math.cos(endAngle - Math.PI / 2);
      const y2 = CY + R * Math.sin(endAngle - Math.PI / 2);
      const large = endAngle - startAngle > Math.PI ? 1 : 0;
      const d = total > 0 && acc - v === 0 && Math.abs(v - total) < 1e-6
        ? `M ${CX - R} ${CY} A ${R} ${R} 0 1 1 ${CX + R} ${CY} A ${R} ${R} 0 1 1 ${CX - R} ${CY} Z`
        : `M ${CX} ${CY} L ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} Z`;
      arcs.push(svgEl('path', { d, fill: s.color, stroke: '#fff', 'stroke-width': '2' }));
    });
  }

  // Hueco central tipo donut con el total
  arcs.push(svgEl('circle', { cx: CX, cy: CY, r: 48, fill: '#fff' }));
  const totalText = svgEl('text', {
    x: CX, y: CY - 4,
    'text-anchor': 'middle',
    'font-family': 'JetBrains Mono, monospace',
    'font-size': '14',
    'font-weight': 'bold',
    fill: '#1b203d',
  });
  totalText.textContent = fmtKg(total);
  const totalLabel = svgEl('text', {
    x: CX, y: CY + 10,
    'text-anchor': 'middle',
    'font-family': 'Inter, sans-serif',
    'font-size': '9',
    'letter-spacing': '0.5',
    fill: '#5a5a55',
  });
  totalLabel.textContent = (opts.unit || 'kg').toUpperCase();

  const node = svg({
    viewBox: `0 0 ${SIZE} ${SIZE}`,
    width: SIZE, height: SIZE,
    style: 'flex-shrink:0;',
  }, [...arcs, totalText, totalLabel]);

  const legend = el('div', { class: 'flex flex-col gap-1.5' },
    slices.map((s) => {
      const pct = total > 0 ? Math.round((s.value / total) * 100) : 0;
      return el('div', { class: 'flex items-center gap-2 text-[12px]' }, [
        el('span', {
          style: `width:10px;height:10px;background:${s.color};border-radius:2px;display:inline-block;`,
        }),
        el('span', { class: 'flex-1 text-ink-700', text: s.label }),
        el('span', { class: 'font-mono text-ink-500', text: `${pct}%` }),
        el('span', { class: 'font-mono text-ink-700 font-semibold w-20 text-right',
          text: fmtKg(s.value) }),
      ]);
    }));

  return el('div', { class: 'flex flex-wrap items-center gap-6 justify-center' }, [
    node, legend,
  ]);
}

// ─────────────────────────────────────────────────────────────────
// Barras agrupadas. Cada categoría (mes) tiene N barras lado a lado.
//   categories: ['May', 'Jun', 'Jul']
//   series: [{ label, color, values }]   values alineadas con categories
// ─────────────────────────────────────────────────────────────────
export function groupedBarChart(categories, series, opts = {}) {
  const W = 640, H = 260;
  const PADL = 50, PADR = 16, PADT = 18, PADB = 50;
  const innerW = W - PADL - PADR;
  const innerH = H - PADT - PADB;
  const showDataLabels = opts.showDataLabels !== false;
  const subLabels = opts.subLabels || [];          // texto chico debajo de cada categoría (ej. eficiencia %)
  const overlayLine = opts.overlayLine || null;    // { label, color, values }

  const allValues = series.flatMap((s) => s.values || []);
  if (overlayLine) allValues.push(...(overlayLine.values || []));
  const max = Math.max(1, ...allValues);
  // Round up to nice tick
  const niceMax = niceCeil(max);
  const gridLines = 4;

  const elements = [];

  // Grid + Y labels
  for (let i = 0; i <= gridLines; i++) {
    const y = PADT + innerH * (1 - i / gridLines);
    const value = (niceMax * i) / gridLines;
    elements.push(svgEl('line', {
      x1: PADL, y1: y, x2: W - PADR, y2: y,
      stroke: '#e8e8e2', 'stroke-width': '0.5',
    }));
    elements.push(svgEl('text', {
      x: PADL - 6, y: y + 3,
      'text-anchor': 'end',
      'font-family': 'JetBrains Mono, monospace',
      'font-size': '9',
      fill: '#9a9a93',
      text: fmtShortKg(value),
    }));
  }

  const groupW = innerW / Math.max(1, categories.length);
  const barGap = 2;
  const innerGroupPad = groupW * 0.18;
  const barsPerGroup = series.length;
  const barW = Math.max(2, (groupW - innerGroupPad * 2 - barGap * (barsPerGroup - 1)) / barsPerGroup);

  categories.forEach((cat, i) => {
    const gx = PADL + i * groupW;
    // X label
    elements.push(svgEl('text', {
      x: gx + groupW / 2,
      y: H - PADB + 14,
      'text-anchor': 'middle',
      'font-family': 'Inter, sans-serif',
      'font-size': '10',
      fill: '#5a5a55',
      text: cat,
    }));
    // Sub label (eficiencia, etc.)
    if (subLabels[i] != null && subLabels[i] !== '') {
      elements.push(svgEl('text', {
        x: gx + groupW / 2,
        y: H - PADB + 28,
        'text-anchor': 'middle',
        'font-family': 'JetBrains Mono, monospace',
        'font-size': '9',
        'font-weight': 'bold',
        fill: '#3a6f4a',
        text: subLabels[i],
      }));
    }
    series.forEach((s, si) => {
      const v = Number((s.values || [])[i] || 0);
      const h = niceMax > 0 ? (v / niceMax) * innerH : 0;
      const bx = gx + innerGroupPad + si * (barW + barGap);
      const by = PADT + innerH - h;
      const rect = svgEl('rect', {
        x: bx, y: by, width: barW, height: h,
        fill: s.color, rx: 1.5,
      });
      // tooltip on hover (Esc en SVG nativo)
      const titleNode = svgEl('title', {});
      titleNode.textContent = `${s.label} · ${cat}: ${fmtKg(v)}`;
      rect.appendChild(titleNode);
      elements.push(rect);
      // Data label arriba de la barra
      if (showDataLabels && v > 0 && h > 14) {
        elements.push(svgEl('text', {
          x: bx + barW / 2,
          y: by - 3,
          'text-anchor': 'middle',
          'font-family': 'JetBrains Mono, monospace',
          'font-size': '8.5',
          'font-weight': 'bold',
          fill: s.color,
          text: fmtShortKg(v),
        }));
      }
    });
  });

  // Overlay line (ej. media móvil)
  if (overlayLine && overlayLine.values && overlayLine.values.length > 0) {
    const points = [];
    overlayLine.values.forEach((v, i) => {
      if (v == null || !isFinite(v)) return;
      const gx = PADL + i * groupW + groupW / 2;
      const gy = PADT + innerH - (niceMax > 0 ? (v / niceMax) * innerH : 0);
      points.push(`${gx},${gy}`);
    });
    if (points.length >= 2) {
      elements.push(svgEl('polyline', {
        points: points.join(' '),
        fill: 'none',
        stroke: overlayLine.color || '#1b203d',
        'stroke-width': '2',
        'stroke-dasharray': '4 3',
        'stroke-linecap': 'round',
      }));
      // Dots con tooltip
      overlayLine.values.forEach((v, i) => {
        if (v == null || !isFinite(v)) return;
        const gx = PADL + i * groupW + groupW / 2;
        const gy = PADT + innerH - (niceMax > 0 ? (v / niceMax) * innerH : 0);
        const dot = svgEl('circle', {
          cx: gx, cy: gy, r: 3,
          fill: overlayLine.color || '#1b203d',
          stroke: '#fff', 'stroke-width': '1.5',
        });
        const t = svgEl('title', {});
        t.textContent = `${overlayLine.label} · ${categories[i]}: ${fmtKg(v)}`;
        dot.appendChild(t);
        elements.push(dot);
      });
    }
  }

  const node = svg({
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
    style: 'width:100%;height:auto;display:block;',
  }, elements);

  const legendItems = series.map((s) => el('div', { class: 'flex items-center gap-1.5 text-[11px]' }, [
    el('span', { style: `width:10px;height:10px;background:${s.color};display:inline-block;border-radius:2px;` }),
    el('span', { class: 'text-ink-700', text: s.label }),
  ]));
  if (overlayLine) {
    legendItems.push(el('div', { class: 'flex items-center gap-1.5 text-[11px]' }, [
      el('span', {
        style: `width:14px;height:0;border-top:2px dashed ${overlayLine.color || '#1b203d'};display:inline-block;`,
      }),
      el('span', { class: 'text-ink-700', text: overlayLine.label }),
    ]));
  }
  const legend = el('div', { class: 'flex flex-wrap items-center gap-4 mt-2 justify-center' }, legendItems);

  return el('div', {}, [node, legend]);
}

// ─────────────────────────────────────────────────────────────────
// Barras horizontales. Para equipos de secado, etc.
//   bars: [{ label, value, color, sublabel }]
// ─────────────────────────────────────────────────────────────────
export function horizontalBarChart(bars, opts = {}) {
  const max = Math.max(1, ...bars.map((b) => Number(b.value || 0)));
  return el('div', { class: 'space-y-2' }, bars.map((b) => {
    const v = Number(b.value || 0);
    const pct = max > 0 ? Math.round((v / max) * 100) : 0;
    return el('div', { class: 'flex items-center gap-3' }, [
      el('div', { class: 'w-28 shrink-0' }, [
        el('p', { class: 'text-[11px] text-ink-700 font-semibold truncate', text: b.label }),
        b.sublabel ? el('p', { class: 'text-[10px] text-ink-300 font-mono truncate', text: b.sublabel }) : null,
      ]),
      el('div', { class: 'flex-1 h-5 bg-cream rounded-md overflow-hidden border border-sand relative' }, [
        el('div', {
          class: 'h-full',
          style: `width:${pct}%;background:${b.color || '#1b203d'};transition:width 0.3s;`,
        }),
      ]),
      el('div', { class: 'w-24 shrink-0 text-right font-mono text-[12px] font-semibold text-navy', text: fmtKg(v) }),
    ]);
  }));
}

// Helpers
function niceCeil(n) {
  if (n <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  const r = n / mag;
  let nice;
  if (r <= 1) nice = 1;
  else if (r <= 2) nice = 2;
  else if (r <= 5) nice = 5;
  else nice = 10;
  return nice * mag;
}

function fmtShortKg(v) {
  if (v >= 1000) return `${Math.round(v / 100) / 10}t`;
  return `${Math.round(v)}`;
}
