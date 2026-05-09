import { el } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { login } from '../auth.js';
import { defaultRouteFor, navigate, setSession } from '../router.js';

export function loginView() {
  const roleSelect = el('select', {
    id: 'role',
    class: 'w-full px-3 py-3 rounded-lg border border-slate-300 bg-white text-base focus:border-forest focus:ring-1 focus:ring-forest outline-none',
  }, [
    el('option', { value: 'forest' }, ['Forest (comercial)']),
    el('option', { value: 'finca' },  ['El Vergel (finca)']),
    el('option', { value: 'admin' },  ['Admin']),
  ]);

  const passInput = el('input', {
    type: 'password',
    id: 'password',
    placeholder: 'Contraseña',
    autocomplete: 'current-password',
    class: 'w-full px-3 py-3 rounded-lg border border-slate-300 text-base focus:border-forest focus:ring-1 focus:ring-forest outline-none',
  });

  const button = el('button', {
    type: 'submit',
    class: 'w-full py-3 rounded-lg bg-forest hover:bg-forest-dark text-white font-medium',
  }, ['Entrar']);

  const form = el('form', {
    class: 'space-y-3',
    onSubmit: async (e) => {
      e.preventDefault();
      const role = roleSelect.value;
      const password = passInput.value;
      if (!password) { toast('Ingresa la contraseña', 'warning'); return; }
      button.disabled = true;
      button.textContent = 'Entrando...';
      try {
        const session = await login(role, password);
        setSession(session);
        navigate(defaultRouteFor(session.role));
      } catch (err) {
        toast(err.message || 'Credenciales inválidas', 'error');
        button.disabled = false;
        button.textContent = 'Entrar';
      }
    },
  }, [
    el('label', { class: 'block text-sm font-medium text-slate-700', for: 'role' }, ['Rol']),
    roleSelect,
    el('label', { class: 'block text-sm font-medium text-slate-700 mt-2', for: 'password' }, ['Contraseña']),
    passInput,
    el('div', { class: 'pt-2' }, [button]),
  ]);

  return el('div', { class: 'min-h-[100dvh] flex items-center justify-center px-4 py-10 bg-gradient-to-b from-forest-dark to-forest' }, [
    el('div', { class: 'w-full max-w-sm bg-white rounded-2xl shadow-xl p-6' }, [
      el('div', { class: 'flex flex-col items-center mb-6' }, [
        el('div', { class: 'w-12 h-12 rounded-xl bg-forest text-white flex items-center justify-center text-xl font-bold mb-2' }, ['F']),
        el('h1', { class: 'text-xl font-semibold text-slate-900' }, ['Forest ↔ El Vergel']),
        el('p', { class: 'text-sm text-slate-500' }, ['Coordinación de producción']),
      ]),
      form,
    ]),
  ]);
}
