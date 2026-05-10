// Admin config view — edita la capacidad semanal y los lead-times
// por proceso. Solo accesible para rol admin.

import { el, clear } from '../ui/el.js';
import { fmtKg, fmtDate } from '../ui/format.js';
import { api } from '../api.js';
import { chrome, pageTitle } from './_chrome.js';
import { toast } from '../ui/toast.js';

export async function adminConfigView() {
  const [cfgRes, leadRes] = await Promise.all([
    api.productionConfigGet(),
    api.processLeadTimes(),
  ]);
  let config = cfgRes.config || { weekly_cherry_capacity_kg: 60000 };
  let leadTimes = leadRes.process_lead_times || [];

  // Asegurar orden estable de procesos
  const ORDER = { Natural: 0, Honey: 1, Lavado: 2 };
  leadTimes = leadTimes.slice().sort((a, b) =>
    (ORDER[a.process_type] ?? 99) - (ORDER[b.process_type] ?? 99));

  const root = el('div', {});
  function redraw() {
    clear(root);
    root.append(
      pageTitle('Configuración', 'Parámetros globales de planificación'),
      capacitySection(config, async (newCap) => {
        try {
          const r = await api.productionConfigUpdate({ weekly_cherry_capacity_kg: newCap });
          config = r.config;
          toast(`Capacidad semanal actualizada a ${fmtKg(config.weekly_cherry_capacity_kg)}`, 'success');
          redraw();
        } catch (e) { toast(e.message, 'error'); }
      }),
      leadTimesSection(leadTimes, async (proc, fields) => {
        try {
          const r = await api.processLeadTimeUpdate({ process_type: proc, ...fields });
          // refresh local list
          leadTimes = leadTimes.map((row) =>
            row.process_type === proc ? { ...row, ...r.row } : row);
          toast(`${proc}: ${describeChanges(fields)}`, 'success');
          redraw();
        } catch (e) { toast(e.message, 'error'); }
      }),
      footerNote(config),
    );
  }
  redraw();

  return chrome(root);
}

function describeChanges(fields) {
  const parts = [];
  if (fields.drying_days != null) parts.push(`drying=${fields.drying_days}d`);
  if (fields.processing_days != null) parts.push(`proc=${fields.processing_days}d`);
  if (fields.dried_to_green_divisor != null) parts.push(`divisor=${fields.dried_to_green_divisor}`);
  return parts.length > 0 ? parts.join(' · ') : 'actualizado';
}

// ─── Capacity section ───────────────────────────────────────────────
function capacitySection(config, onSave) {
  const input = el('input', {
    type: 'number', min: '1', step: '100',
    value: String(config.weekly_cherry_capacity_kg),
    class: 'ctrm-input mono',
  });
  const help = el('p', { class: 'ctrm-hint mt-1' });
  const updateHelp = () => {
    const v = Number(input.value || 0);
    const greenEquiv = v / 7.65;
    help.textContent = v > 0
      ? `≈ ${fmtKg(greenEquiv)} de verde / semana (÷ 7.65)`
      : 'Capacidad debe ser > 0';
  };
  input.addEventListener('input', updateHelp);
  updateHelp();

  const saveBtn = el('button', {
    class: 'ctrm-btn ctrm-btn-primary',
    type: 'button',
    onClick: () => {
      const v = Number(input.value);
      if (!(v > 0)) { toast('Capacidad inválida', 'warning'); return; }
      if (v === config.weekly_cherry_capacity_kg) {
        toast('Sin cambios', 'info', 1500);
        return;
      }
      onSave(v);
    },
  }, ['Guardar']);

  return el('section', { class: 'ctrm-card ctrm-card-pad mb-5' }, [
    el('h3', { class: 'eyebrow mb-2', text: 'Capacidad semanal de procesamiento' }),
    el('p', { class: 'text-[12px] text-ink-500 mb-3' }, [
      'Volumen máximo de cereza que la planta puede procesar en una semana ISO. ',
      'Se usa en /finca/cola y en el panel "Carga semanal" para marcar las semanas sobrecargadas.',
    ]),
    el('div', { class: 'grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2 items-end' }, [
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'kg cereza / semana' }),
        input,
        help,
      ]),
      saveBtn,
    ]),
  ]);
}

// ─── Lead times per process ─────────────────────────────────────────
function leadTimesSection(rows, onSave) {
  if (rows.length === 0) {
    return el('section', { class: 'ctrm-card ctrm-card-pad mb-5' }, [
      el('p', { class: 'text-ink-300 italic', text: 'No hay procesos cargados.' }),
    ]);
  }

  return el('section', { class: 'ctrm-card ctrm-card-pad mb-5' }, [
    el('h3', { class: 'eyebrow mb-2', text: 'Lead times por proceso' }),
    el('p', { class: 'text-[12px] text-ink-500 mb-3' }, [
      'Días de drying y procesamiento previo (fermentación + despulpado + secado al sol). ',
      'El "drying-start" máximo de un pedido = entrega − (drying + procesamiento). ',
      'El divisor seco→verde se usa cuando un lote se cierra sin factor explícito.',
    ]),
    el('div', { class: 'space-y-2' }, rows.map((r) => leadTimeRow(r, onSave))),
  ]);
}

function leadTimeRow(row, onSave) {
  const dryingInput = el('input', {
    type: 'number', min: '1', step: '1',
    value: String(row.drying_days), class: 'ctrm-input mono w-24',
  });
  const procInput = el('input', {
    type: 'number', min: '0', step: '1',
    value: String(row.processing_days ?? 6), class: 'ctrm-input mono w-24',
  });
  const divisorInput = el('input', {
    type: 'number', min: '0.01', step: '0.01',
    value: String(row.dried_to_green_divisor), class: 'ctrm-input mono w-24',
  });

  const totalHint = el('span', { class: 'text-[11px] text-ink-500 font-mono' });
  const updateHint = () => {
    const d = Number(dryingInput.value || 0);
    const p = Number(procInput.value || 0);
    totalHint.textContent = (d > 0 && p >= 0)
      ? `Lead total: ${d + p}d antes de la entrega`
      : '';
  };
  dryingInput.addEventListener('input', updateHint);
  procInput.addEventListener('input', updateHint);
  updateHint();

  const saveBtn = el('button', {
    class: 'ctrm-btn ctrm-btn-soft ctrm-btn-sm',
    type: 'button',
    onClick: () => {
      const fields = {};
      const d = Number(dryingInput.value);
      const p = Number(procInput.value);
      const v = Number(divisorInput.value);
      if (Number.isFinite(d) && d > 0 && d !== Number(row.drying_days)) fields.drying_days = d;
      if (Number.isFinite(p) && p >= 0 && p !== Number(row.processing_days ?? 6)) fields.processing_days = p;
      if (Number.isFinite(v) && v > 0 && Math.abs(v - Number(row.dried_to_green_divisor)) > 1e-9) fields.dried_to_green_divisor = v;
      if (Object.keys(fields).length === 0) { toast('Sin cambios', 'info', 1500); return; }
      onSave(row.process_type, fields);
    },
  }, ['Guardar']);

  return el('div', {
    class: 'rounded-md border border-sand p-3',
  }, [
    el('div', { class: 'flex items-center gap-2 mb-2 flex-wrap' }, [
      el('span', { class: 'ctrm-pill dark', text: row.process_type }),
      totalHint,
    ]),
    el('div', { class: 'grid grid-cols-2 sm:grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end' }, [
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Drying (d)' }),
        dryingInput,
      ]),
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Procesamiento (d)' }),
        procInput,
      ]),
      el('div', {}, [
        el('label', { class: 'ctrm-label', text: 'Divisor seco→verde' }),
        divisorInput,
      ]),
      saveBtn,
    ]),
  ]);
}

function footerNote(config) {
  return el('p', { class: 'text-[11px] text-ink-300 italic mt-3' }, [
    config.updated_at
      ? `Última actualización: ${fmtDate(config.updated_at)}${config.updated_by ? ` por ${config.updated_by}` : ''}.`
      : '',
    ' Los cambios se reflejan en /finca/cola y el dashboard al recargar (puede tomar unos segundos por el cache del servidor).',
  ]);
}
