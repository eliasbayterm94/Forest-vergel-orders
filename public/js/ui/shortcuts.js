// Keyboard shortcuts globales. Se montan una sola vez via mountShortcuts()
// desde main.js. Ignoran inputs/textareas/contenteditable.

import { navigate, currentPath } from '../router.js';
import { openModal } from './modal.js';
import { el } from './el.js';

const SHORTCUTS = [
  {
    keys: '/',
    label: 'Buscar',
    desc: 'Enfoca la barra de búsqueda en el topbar.',
    run: () => {
      const input = document.querySelector('.topbar-search-input');
      if (input) { input.focus(); input.select(); }
    },
  },
  {
    keys: 'n',
    label: 'Nuevo',
    desc: 'Crea un nuevo pedido (forest) o lote (finca).',
    run: (session) => {
      const role = session?.role;
      if (role === 'forest' || role === 'admin') return navigate('/forest/demand');
      if (role === 'finca')                       return navigate('/finca/lots');
    },
  },
  {
    keys: 'g d',
    label: 'Ir al tablero',
    desc: 'Navega al tablero del rol actual.',
    run: (session) => {
      const role = session?.role;
      if (role === 'forest') return navigate('/forest/dashboard');
      if (role === 'finca')  return navigate('/finca/dashboard');
      if (role === 'admin')  return navigate('/admin/dashboard');
    },
  },
  {
    keys: 'g l',
    label: 'Ir a producción',
    desc: 'Navega a /finca/lots.',
    run: () => navigate('/finca/lots'),
  },
  {
    keys: 'g i',
    label: 'Ir al inbox',
    desc: 'Navega a /finca/inbox.',
    run: () => navigate('/finca/inbox'),
  },
  {
    keys: 'g s',
    label: 'Ir a despachos',
    desc: 'Navega a /finca/despachos.',
    run: () => navigate('/finca/despachos'),
  },
  {
    keys: 'g r',
    label: 'Ir a reportes',
    desc: 'Navega a /reports.',
    run: () => navigate('/reports'),
  },
  {
    keys: '?',
    label: 'Ayuda',
    desc: 'Lista todos los atajos disponibles.',
    run: () => showHelp(),
  },
];

let _session = null;
let _chordPrefix = null;
let _chordTimer  = null;

function isTypingTarget(target) {
  if (!target) return false;
  const tag = (target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}

function clearChord() {
  _chordPrefix = null;
  if (_chordTimer) { clearTimeout(_chordTimer); _chordTimer = null; }
}

function dispatchKey(key) {
  // Match exact + chord. Si la tecla coincide con un prefijo (e.g. "g"),
  // armamos un chord; el siguiente keydown completa la combinacion.
  // Si nada matchea en 1500ms, abandonamos el chord.
  if (_chordPrefix) {
    const combined = `${_chordPrefix} ${key}`;
    clearChord();
    const sc = SHORTCUTS.find((s) => s.keys === combined);
    if (sc) sc.run(_session);
    return;
  }
  // Prefijo de chord: hay algun shortcut "X Y" con primer token igual
  const isChordPrefix = SHORTCUTS.some((s) => s.keys.startsWith(`${key} `));
  if (isChordPrefix) {
    _chordPrefix = key;
    _chordTimer  = setTimeout(clearChord, 1500);
    return;
  }
  const sc = SHORTCUTS.find((s) => s.keys === key);
  if (sc) sc.run(_session);
}

export function mountShortcuts(getSession) {
  document.addEventListener('keydown', (e) => {
    _session = typeof getSession === 'function' ? getSession() : getSession;
    if (e.metaKey || e.ctrlKey || e.altKey) return;     // no interferir con browser shortcuts
    if (isTypingTarget(e.target)) return;

    // "/" abre busqueda incluso sin chord.
    if (e.key === '/') {
      e.preventDefault();
      dispatchKey('/');
      return;
    }
    if (e.key === '?') {
      e.preventDefault();
      dispatchKey('?');
      return;
    }
    if (e.key.length === 1) {
      const k = e.key.toLowerCase();
      // Solo letras + algunos especiales
      if (/[a-z]/.test(k)) {
        e.preventDefault();
        dispatchKey(k);
      }
    }
  });
}

function showHelp() {
  return openModal(({ close }) => {
    return el('div', { class: 'space-y-2' }, [
      el('p', { class: 'text-[12px] text-ink-700 mb-2' }, [
        'Atajos disponibles. Funcionan cuando no estás escribiendo en un campo.',
      ]),
      el('div', { class: 'space-y-1' }, SHORTCUTS.map((s) =>
        el('div', {
          class: 'flex items-baseline justify-between gap-3 py-1.5 border-b border-sand last:border-b-0',
        }, [
          el('div', { class: 'flex-1 min-w-0' }, [
            el('p', { class: 'text-[12px] font-display font-semibold text-navy', text: s.label }),
            el('p', { class: 'text-[11px] text-ink-500', text: s.desc }),
          ]),
          el('kbd', {
            class: 'font-mono text-[11px] bg-cream border border-sand px-2 py-0.5 rounded',
            text: s.keys.toUpperCase(),
          }),
        ])
      )),
      el('div', { class: 'flex justify-end pt-3 border-t border-sand' }, [
        el('button', { class: 'ctrm-btn ctrm-btn-soft', type: 'button', onClick: () => close(null) }, ['Cerrar']),
      ]),
    ]);
  }, { title: 'Atajos de teclado' });
}
