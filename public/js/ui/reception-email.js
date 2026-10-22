// El correo de recepción: "llegó café, esto fue lo que llegó".
//
// Replica el formato que la finca ya manda a mano después de cada
// entrega, armado con los datos de la recepción. Devuelve asunto y
// cuerpo en texto plano — nada se envía desde acá: el botón abre un
// borrador en el cliente de correo de quien lo aprieta, para que lo
// revise, le ponga los destinatarios y lo mande él.
//
// Se abre como borrador a propósito. El correo real lo manda la
// persona que pesó el café, no el sistema: el precio se confirma con
// alguien, a veces hay que explicar un percance, y un correo que sale
// solo no deja espacio para eso.
//
// Cada línea cuyo dato no esté se omite, en vez de salir con un guión:
// un correo con "Brix: —" se lee como que el laboratorio falló.

const NF = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NF0 = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

const num = (n) => NF.format(Number(n));
const cop = (n) => `$${NF0.format(Math.round(Number(n)))}`;
// 0.098 -> "9.8", sin ceros de relleno.
const asPct = (frac, dp = 1) => {
  const v = Number(frac) * 100;
  return (Math.round(v * 10 ** dp) / 10 ** dp).toFixed(dp).replace(/\.0$/, '');
};
const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v));

// dd-mm-yyyy, como en el correo que ya se manda.
function dmy(yyyyMmDd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(yyyyMmDd || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(yyyyMmDd || '');
}

/**
 * Asunto y cuerpo del correo de una recepción.
 *
 * @param {object} reception  fila de cherry-receptions-list (con kg_net
 *                            y byproduct_summary ya derivados)
 * @param {object} [supplier] el proveedor, para el nombre y la franquicia
 * @returns {{subject: string, body: string}}
 */
export function receptionEmailDraft(reception, supplier = null) {
  const r = reception || {};
  const sup = supplier || {};
  const bp = r.byproduct_summary || null;
  const supplierName = sup.name || r.supplier_name || null;
  const origin = r.pool_key || supplierName || null;

  const subject = `Recepción ${r.reception_code || ''} · ${dmy(r.received_date)}`
    + (origin ? ` · ${origin}` : '');

  const L = [];
  L.push('Buenos días para todos.');
  L.push('');

  // El renglón de pesaje. Con lonas se explica la tara; sin ellas se
  // reporta solo lo que se recibió.
  const kgNetOfTare = isNum(r.kg_gross) ? num(r.kg_gross) : null;
  if (isNum(r.kg_scale_gross) && isNum(r.sacks_count)) {
    const tare = isNum(r.tare_per_sack_kg) ? Number(r.tare_per_sack_kg) : null;
    L.push(
      `El día ${dmy(r.received_date)} se recepcionaron ${num(r.kg_scale_gross)} kg`
      + ` en ${r.sacks_count} lonas${tare != null ? ` - (${num(Number(r.sacks_count) * tare)} kg)` : ''}`
      + ` para un total neto de ${kgNetOfTare} kg.`,
    );
  } else if (kgNetOfTare) {
    L.push(`El día ${dmy(r.received_date)} se recepcionaron ${kgNetOfTare} kg.`);
  }
  L.push('');

  if (origin) L.push(origin);
  if (bp && isNum(bp.byproduct_pct) && Number(bp.kg_byproduct) > 0) {
    // Si el flote se estimó se dice, para que nadie lo lea como pesado.
    L.push(`Prueba de flotes: ${asPct(bp.byproduct_pct)} %`
      + (bp.has_estimates ? ' (estimado)' : ''));
  }
  if (isNum(r.brix_pct)) L.push(`Brix: ${Number(r.brix_pct).toFixed(1)} %`);
  if (isNum(r.ph)) L.push(`Ph: ${Number(r.ph).toFixed(2)}`);
  if (isNum(r.cherry_to_pulped_ratio)) {
    const c = Number(r.cherry_to_pulped_ratio);
    L.push(`Café cereza a café despulpado (conversión): ${c} o ${asPct(c)} %`);
  }

  if (isNum(r.price_per_kg)) {
    L.push('');
    L.push(`El negocio quedó cerrado${origin ? ` para ${origin}` : ''}`
      + ` a ${cop(r.price_per_kg)} pesos el kilo puesto en Finca.`);
  }

  // El descuento, con el porqué cuando hay franquicia pactada: ese
  // "a partir del 5 %" es lo que explica un 4.8 % frente a un 9.8 %.
  const disc = isNum(r.discount_pct) ? Number(r.discount_pct) : 0;
  if (disc > 0) {
    L.push('');
    const f = isNum(sup.floater_franchise_pct) ? Number(sup.floater_franchise_pct) : 0;
    const rate = bp && isNum(bp.byproduct_pct) ? Number(bp.byproduct_pct) : null;
    if (f > 0 && rate != null) {
      L.push(`Al ${asPct(rate)} % de flote se le realizará el descuento a partir del ${asPct(f)} %,`
        + ` para un descuento del ${asPct(disc)} %.`);
    } else {
      L.push(`Se aplicó un descuento del ${asPct(disc)} %.`);
    }
  }

  if (isNum(r.amount_paid_cop)) {
    L.push('');
    L.push(`Valor a pagar: ${cop(r.amount_paid_cop)}`);
  }

  L.push('');
  L.push('Nota: Generar factura para dejar trazabilidad en este mismo correo con soporte de consignación.');

  return { subject, body: L.join('\n') };
}

/**
 * mailto: de un borrador. Sin destinatarios a propósito — el correo va
 * a un grupo que cambia, y meter la lista en el frontend repartiría
 * direcciones a todo el que abra la pantalla. El cliente de correo las
 * autocompleta.
 */
export function receptionMailtoUrl(reception, supplier = null) {
  const { subject, body } = receptionEmailDraft(reception, supplier);
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
