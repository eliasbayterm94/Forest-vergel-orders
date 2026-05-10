import { el } from '../ui/el.js';
import { toast } from '../ui/toast.js';
import { login } from '../auth.js';
import { defaultRouteFor, navigate, setSession } from '../router.js';

export function loginView() {
  const roleSelect = el('select', {
    id: 'role',
    class: 'ctrm-select',
  }, [
    el('option', { value: 'forest' }, ['Forest (comercial)']),
    el('option', { value: 'finca' },  ['El Vergel (finca)']),
    el('option', { value: 'admin' },  ['Admin']),
  ]);

  const passInput = el('input', {
    type: 'password',
    id: 'password',
    placeholder: '••••••••',
    autocomplete: 'current-password',
    class: 'ctrm-input mono',
  });

  const button = el('button', {
    type: 'submit',
    class: 'ctrm-btn ctrm-btn-yellow w-full uppercase tracking-eyebrow text-[11px] py-3',
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
    el('div', {}, [
      el('label', { class: 'ctrm-label', for: 'role' }, ['Rol']),
      roleSelect,
    ]),
    el('div', {}, [
      el('label', { class: 'ctrm-label', for: 'password' }, ['Contraseña']),
      passInput,
    ]),
    el('div', { class: 'pt-3' }, [button]),
  ]);

  return el('div', { class: 'min-h-[100dvh] flex items-center justify-center px-4 py-10', style: { background: 'linear-gradient(160deg, #0c0c0b 0%, #1b203d 100%)' } }, [
    el('div', { class: 'w-full max-w-sm bg-white rounded-2xl shadow-card-2 p-7 sm:p-8' }, [
      el('div', { class: 'flex items-center gap-3 mb-7' }, [
        el('div', { class: 'ctrm-topbar-logo' }, ['F×V']),
        el('div', { class: 'flex flex-col' }, [
          el('h1', { class: 'font-display font-bold text-[16px] tracking-loose text-navy uppercase' }, ['Forest ↔ El Vergel']),
          el('p', { class: 'text-[11px] text-ink-500 font-mono tracking-loose' }, ['Production Bridge']),
        ]),
      ]),
      form,
      el('p', { class: 'mt-6 text-[10px] text-ink-300 text-center font-mono tracking-loose uppercase' }, ['Coordinación de producción · Forest Coffee']),
    ]),
  ]);
}
