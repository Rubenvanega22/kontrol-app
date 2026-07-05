-- 2026-07-05 — Blindar funciones de TRIGGER expuestas como RPC a anon/authenticated.
-- crear_pago_recurrente_siguiente() (trigger de pagos recurrentes) y
-- handle_new_user() (trigger de auth.users que crea el profile) son SECURITY
-- DEFINER; Supabase las expone via PostgREST como RPC ejecutable por anon y
-- authenticated (advisories 0028/0029). No son RPC, son triggers.
--
-- Revocamos EXECUTE de PUBLIC + anon + authenticated. postgres y service_role
-- quedan intactos. Los triggers SIGUEN disparando: Postgres no chequea el
-- privilegio EXECUTE al ejecutar una funcion de trigger (verificado end-to-end).
--
-- registrar_pago() NO se toca: el frontend la llama legitimamente via supa.rpc().
-- Ya aplicada en produccion via MCP.

REVOKE EXECUTE ON FUNCTION public.crear_pago_recurrente_siguiente() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
