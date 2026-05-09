import { el } from '../ui/el.js';
import { chrome, pageTitle } from './_chrome.js';

export function fincaPlaceholderView({ title, subtitle }) {
  return chrome(el('div', {}, [
    pageTitle(title, subtitle),
    el('div', { class: 'bg-white rounded-xl border border-dashed border-slate-300 p-8 text-center' }, [
      el('p', { class: 'text-slate-500 mb-2' }, ['Esta vista se construirá en la Fase 4.']),
      el('p', { class: 'text-xs text-slate-400' }, ['(Vista placeholder)']),
    ]),
  ]));
}
