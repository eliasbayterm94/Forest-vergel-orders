-- ============================================================
-- 0048_users.sql
--
-- USUARIOS individuales con contraseña en base de datos.
--
-- Reemplaza el login por "clave compartida por rol" guardada en
-- variables de entorno de Netlify (FOREST/FINCA/ADMIN_PASSWORD_HASH),
-- que obligaba a tocar la consola de Netlify + redeploy para cambiar
-- una clave. Ahora:
--
--   · Cada persona tiene su propio usuario y contraseña
--   · El rol (forest/finca/admin) viene de la fila del usuario
--   · El admin crea/edita usuarios desde /admin/config
--   · Resetear una clave olvidada = un UPDATE acá (ver abajo),
--     sin Netlify y sin redeploy
--
-- El hash es bcrypt (rounds=12), compatible entre pgcrypto
-- (crypt + gen_salt('bf', 12)) y bcryptjs, que es lo que usa
-- netlify/functions/_lib/auth.js para verificar.
--
-- COMPATIBILIDAD: mientras no exista ningún usuario activo, el login
-- sigue aceptando las claves por rol de las env vars (usando el
-- nombre del rol como usuario). Eso evita quedarse afuera si esta
-- migración corre antes o después del deploy. En cuanto se crea el
-- primer usuario activo, ese camino deja de usarse.
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username       citext NOT NULL UNIQUE,
  full_name      text,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('forest', 'finca', 'admin')),
  active         boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- El login busca por username; los listados ordenan por username.
CREATE INDEX IF NOT EXISTS idx_users_active ON users (active);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Deny-all por defecto: todo el tráfico pasa por las Netlify Functions
-- con service_role, que hace bypass de RLS. Misma postura que 0005.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE users IS
  'Usuarios individuales del sistema. Login = username + password (bcrypt). El rol de la fila define los permisos. Resetear clave: UPDATE users SET password_hash = crypt(''nueva'', gen_salt(''bf'', 12)) WHERE username = ''...'';';

COMMENT ON COLUMN users.password_hash IS
  'bcrypt rounds=12. Generar con crypt(''clave'', gen_salt(''bf'', 12)).';


-- ============================================================
-- BOOTSTRAP — crear el primer admin
--
-- Descomentá el INSERT de abajo y cambiá usuario y clave ANTES de
-- correr la migración. O corrélo suelto en el SQL Editor después.
--
--   INSERT INTO users (username, full_name, password_hash, role)
--   VALUES ('elias', 'Elias Bayter',
--           crypt('CAMBIAR-ESTA-CLAVE', gen_salt('bf', 12)), 'admin')
--   ON CONFLICT (username) DO NOTHING;
--
-- ------------------------------------------------------------
-- RESETEAR UNA CLAVE OLVIDADA (la razón de existir de esta tabla):
--
--   UPDATE users
--      SET password_hash = crypt('la-clave-nueva', gen_salt('bf', 12))
--    WHERE username = 'elias';
--
-- Efecto inmediato. Sin redeploy.
--
-- Nota: cambiar la clave NO cierra las sesiones ya abiertas (la cookie
-- dura 7 días). Para cortar todos los accesos al instante hay que
-- rotar JWT_SECRET en Netlify y redesplegar.
-- ============================================================
