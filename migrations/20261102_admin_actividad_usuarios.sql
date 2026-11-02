-- 2026-11-02 — Panel Admin: saber quién está usando Kontrol.
--   1. profiles.ultima_apertura_at: la primera vez de cada día que el usuario abre la app.
--      La escribe la propia app, como máximo una vez al día.
--   2. admin_actividad_usuarios(): la última actividad de cada usuario. El panel corre en
--      el navegador y RLS no le deja leer tablas ajenas, por eso es SECURITY DEFINER.
--      Solo el admin la puede ejecutar y solo devuelve fecha y tipo, nunca contenido.
--
-- Fuentes: mensajes enviados por WhatsApp y filas creadas en recordatorios, agenda, pagos,
-- hojas y lugares, más la fecha en que se marcó un pago. La Caja fuerte queda por fuera a
-- propósito. Los crons no crean filas en estas tablas, así que no cuentan como actividad.
-- Límite: estas tablas no guardan fecha de edición, así que editar una fila no cuenta.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ultima_apertura_at timestamptz;

CREATE OR REPLACE FUNCTION public.admin_actividad_usuarios()
RETURNS TABLE (user_id uuid, ultima_actividad timestamptz, origen text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS DISTINCT FROM 'bec85cec-8c85-460a-8c1e-31c6eb4e0eac'::uuid THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT DISTINCT ON (a.uid) a.uid, a.cuando, a.tipo
  FROM (
    SELECT c.user_id AS uid, max(c.created_at) AS cuando, 'WhatsApp'::text AS tipo
      FROM public.whatsapp_conversations c WHERE c.role = 'user' GROUP BY c.user_id
    UNION ALL
    SELECT r.user_id, max(r.created_at),
           CASE WHEN r.tipo IN ('listado', 'lista') THEN 'Listado' ELSE 'Recordatorios' END
      FROM public.reminders r
      GROUP BY r.user_id, CASE WHEN r.tipo IN ('listado', 'lista') THEN 'Listado' ELSE 'Recordatorios' END
    UNION ALL
    SELECT e.user_id, max(e.created_at), 'Agenda' FROM public.events e GROUP BY e.user_id
    UNION ALL
    SELECT p.user_id, max(p.created_at), 'Pagos' FROM public.payments p GROUP BY p.user_id
    UNION ALL
    SELECT p.user_id, max((p.fecha_pago::timestamp) AT TIME ZONE 'America/Bogota'), 'Pago marcado'
      FROM public.payments p WHERE p.fecha_pago IS NOT NULL GROUP BY p.user_id
    UNION ALL
    SELECT h.user_id, max(h.created_at), 'Hojas' FROM public.hojas h GROUP BY h.user_id
    UNION ALL
    SELECT u.user_id, max(u.created_at), 'Lugares' FROM public.ubicaciones u GROUP BY u.user_id
  ) a
  WHERE a.uid IS NOT NULL AND a.cuando IS NOT NULL
  ORDER BY a.uid, a.cuando DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_actividad_usuarios() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_actividad_usuarios() TO authenticated;
