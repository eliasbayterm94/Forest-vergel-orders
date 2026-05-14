// Marca un botón como "ocupado" mientras se ejecuta una promesa:
// lo deshabilita, cambia el texto a `busyLabel` y al terminar
// (éxito o error) restaura el estado original.
//
// Uso:
//   const btn = el('button', { class: 'ctrm-btn ctrm-btn-primary', ... });
//   onClick: async () => {
//     await withBusy(btn, 'Creando…', async () => {
//       await api.lotCreate(payload);
//     });
//   }
//
// El finally garantiza que el botón se restaura incluso si el callback
// lanza. Si el botón ya no está montado (ej. el modal se cerró),
// las asignaciones siguen siendo idempotentes y no rompen nada.

export async function withBusy(btn, busyLabel, fn) {
  if (!btn) return fn();
  const originalText = btn.textContent;
  const wasDisabled  = btn.disabled;
  btn.disabled = true;
  btn.classList.add('is-busy');
  btn.textContent = busyLabel;
  try {
    return await fn();
  } finally {
    btn.disabled = wasDisabled;
    btn.classList.remove('is-busy');
    btn.textContent = originalText;
  }
}
