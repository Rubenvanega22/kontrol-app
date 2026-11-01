-- 2026-11-01 — Auditoria RLS: endurece permisos. NO cambia ninguna politica:
-- las 26 tablas ya tienen RLS y las politicas de fila son correctas.
-- Ya aplicada en produccion via MCP.
--
-- Efecto:
--   1. anon sin permisos sobre tablas. Hoy no ve filas por RLS, pero conserva
--      GRANT ALL, incluido TRUNCATE, que RLS no filtra.
--   2. Tablas de sistema: tampoco authenticated. Solo service key.
--   3. authenticated sin TRUNCATE, TRIGGER ni REFERENCES.
--   4. Las tablas nuevas ya no nacen con permisos para anon.
--   5. registrar_pago deja de ser ejecutable por anon. Su chequeo
--      "auth.uid() IS NOT NULL AND auth.uid() <> p_user_id" no frena a anon porque
--      auth.uid() es NULL, y al ser SECURITY DEFINER se salta RLS: bastaba conocer
--      el user_id para descontar saldos y marcar pagos ajenos.
--      El cuerpo de la funcion no se toca.
--
-- service_role no se ve afectado, asi que los endpoints de api/ siguen igual.
-- Riesgo: una consulta sin sesion ahora responde error de permisos en vez de
-- lista vacia. syncDesdeSupabase ya no consulta si no hay currentUser.

BEGIN;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

REVOKE ALL ON public.whatsapp_alerts,
              public.whatsapp_conversations,
              public.whatsapp_state,
              public.config,
              public.invitaciones
  FROM authenticated;

REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLES FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.registrar_pago(uuid, integer, jsonb, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_pago(uuid, integer, jsonb, date) TO authenticated, service_role;

COMMIT;
