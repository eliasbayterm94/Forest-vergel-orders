// Validacion inline simple para forms. El input se marca con borde rojo
// y aparece un <p> de error abajo. clearError limpia ambas cosas.
//
// Pensado como red de seguridad temprana: validar en blur evita que el
// usuario clickee submit y reciba toast errors. El submit final sigue
// siendo la fuente de verdad (servidor + toast post-fail).

import { el } from './el.js';

const INVALID_CLASS = 'ctrm-input-invalid';

export function setFieldError(input, message) {
  if (!input) return;
  input.classList.add(INVALID_CLASS);
  let err = input.nextElementSibling;
  if (!err || !err.classList || !err.classList.contains('ctrm-field-error')) {
    err = el('p', { class: 'ctrm-field-error' });
    input.parentNode.insertBefore(err, input.nextSibling);
  }
  err.textContent = message || 'Campo inválido';
}

export function clearFieldError(input) {
  if (!input) return;
  input.classList.remove(INVALID_CLASS);
  const err = input.nextElementSibling;
  if (err && err.classList && err.classList.contains('ctrm-field-error')) {
    err.remove();
  }
}

/**
 * Bind validation:
 *   bindValidation(input, validator, message?)
 *
 *   validator(value) → true | false
 *   message: string a mostrar cuando false (puede ser fn(value))
 *
 * Se valida en blur y, si ya estaba marcado como invalido, tambien en
 * input para limpiar de inmediato cuando el usuario corrige.
 */
export function bindValidation(input, validator, message = 'Campo inválido') {
  if (!input) return;
  const run = () => {
    const v = input.value;
    if (validator(v)) {
      clearFieldError(input);
    } else {
      setFieldError(input, typeof message === 'function' ? message(v) : message);
    }
  };
  input.addEventListener('blur', run);
  input.addEventListener('input', () => {
    if (input.classList.contains(INVALID_CLASS)) run();
  });
}
