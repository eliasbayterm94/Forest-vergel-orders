-- =====================================================================
-- Forest Production Bridge — 0005_rls
-- Row-Level Security: deny-all default. All app traffic goes through
-- Netlify Functions using the service_role key (which bypasses RLS).
-- The anon key is NEVER used by the client beyond auth gating, but we
-- enable RLS as defense-in-depth in case the anon key leaks.
-- =====================================================================

ALTER TABLE coffee_varieties             ENABLE ROW LEVEL SECURITY;
ALTER TABLE coffee_references            ENABLE ROW LEVEL SECURITY;
ALTER TABLE coffee_reference_varieties   ENABLE ROW LEVEL SECURITY;
ALTER TABLE process_lead_times           ENABLE ROW LEVEL SECURITY;
ALTER TABLE demand_orders                ENABLE ROW LEVEL SECURITY;
ALTER TABLE demand_order_varieties       ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_lots              ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_lot_varieties     ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot_order_assignments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_log                    ENABLE ROW LEVEL SECURITY;

-- No policies are created. With RLS enabled and no policies, all access
-- via the anon key is blocked. service_role bypasses RLS by default,
-- which is what every Netlify Function uses.
