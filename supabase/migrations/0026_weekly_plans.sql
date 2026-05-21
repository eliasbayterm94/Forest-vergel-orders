-- ============================================================
-- 0026_weekly_plans.sql
--
-- Motor de planeación semanal. Guarda el plan vigente de la
-- semana (un row por week_start_date, lunes ISO). Al recalcular
-- se sobreescribe.
--
-- Inputs: cantidades por día y por tipo de café (cereza,
-- despulpado, seco) que se esperan recibir. Se guardan en JSONB
-- para flexibilidad: { "YYYY-MM-DD": { cereza, despulpado, seco } }.
--
-- Output (plan_json): array por día con los baches planificados,
-- ocupaciones de capacidad y referencias a pedidos.
--
-- alerts_json: list de avisos {kind, message, day?, order_id?}.
-- ============================================================

CREATE TABLE weekly_plans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start_date   date NOT NULL UNIQUE,

  day_inputs        jsonb NOT NULL DEFAULT '{}'::jsonb,
  plan_json         jsonb NOT NULL DEFAULT '[]'::jsonb,
  alerts_json       jsonb NOT NULL DEFAULT '[]'::jsonb,
  feasibility_pct   numeric(5,2),

  generated_at      timestamptz NOT NULL DEFAULT now(),
  generated_by      text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_weekly_plans_week ON weekly_plans(week_start_date);

CREATE TRIGGER trg_weekly_plans_updated_at
BEFORE UPDATE ON weekly_plans
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE weekly_plans IS
  'Plan semanal de procesamiento. Un row por semana (sobreescribible).';
COMMENT ON COLUMN weekly_plans.day_inputs IS
  'Inputs proyectados por día: { "YYYY-MM-DD": { cereza, despulpado, seco } } en kg.';
COMMENT ON COLUMN weekly_plans.plan_json IS
  'Plan generado: array de 7 días, cada uno con baches planificados y ocupaciones.';
COMMENT ON COLUMN weekly_plans.alerts_json IS
  'Avisos generados al calcular: array de {kind, message, day?, order_id?}.';

ALTER TABLE weekly_plans ENABLE ROW LEVEL SECURITY;
