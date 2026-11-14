-- 2026-11-14 — Novedades: ventana "Esto es lo nuevo" al abrir la app.
--   1. novedades: una fila por cambio que los usuarios noten. publicada_at decide el orden
--      y desde cuándo se muestra (una fecha futura queda programada).
--   2. profiles.novedades_vistas_at: hasta qué publicada_at vio cada usuario. Sin valor,
--      cuenta desde su registro (profiles.created_at): los nuevos no ven lo anterior.
--   3. RLS: cualquier usuario con sesión lee; solo el admin agrega, edita y borra.
-- Regla: cada cambio visible se publica con su novedad, en lenguaje sencillo.

BEGIN;

CREATE TABLE IF NOT EXISTS public.novedades (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publicada_at timestamptz NOT NULL DEFAULT now(),
  titulo       text NOT NULL CHECK (char_length(titulo) BETWEEN 1 AND 40),
  descripcion  text NOT NULL CHECK (char_length(descripcion) BETWEEN 1 AND 90),
  icono        text NOT NULL DEFAULT 'i-ia' CHECK (icono ~ '^i-[a-z]+$'),
  pantalla     text NOT NULL DEFAULT 'inicio'
               CHECK (pantalla IN ('inicio','agenda','listado','pagos','caja','config','whatsapp')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS novedades_publicada_idx ON public.novedades (publicada_at DESC);

ALTER TABLE public.novedades ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "novedades leer" ON public.novedades;
CREATE POLICY "novedades leer" ON public.novedades
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "novedades admin" ON public.novedades;
CREATE POLICY "novedades admin" ON public.novedades
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = 'bec85cec-8c85-460a-8c1e-31c6eb4e0eac'::uuid)
  WITH CHECK ((SELECT auth.uid()) = 'bec85cec-8c85-460a-8c1e-31c6eb4e0eac'::uuid);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS novedades_vistas_at timestamptz;

-- Novedades de noviembre 2026 (solo si la tabla está vacía, para poder re-aplicar).
INSERT INTO public.novedades (publicada_at, titulo, descripcion, icono, pantalla)
SELECT v.* FROM (VALUES
  ('2026-11-01 12:00-05'::timestamptz, 'Kontrol tiene nueva cara', 'Colores, letras y botones más claros y fáciles de tocar.', 'i-ia', 'inicio'),
  ('2026-11-01 12:01-05'::timestamptz, 'Pantalla de Inicio', 'Tu día de un vistazo: citas, pagos y pendientes.', 'i-home', 'inicio'),
  ('2026-11-01 12:02-05'::timestamptz, 'Listas y facturas con una foto', 'Tómale una foto a una lista o a una factura y Kontrol la organiza por ti.', 'i-cam', 'listado'),
  ('2026-11-02 12:00-05'::timestamptz, 'Citas por WhatsApp', 'Agenda una cita escribiéndole al bot y elige a qué hora quieres el aviso.', 'i-cal', 'agenda'),
  ('2026-11-03 12:00-05'::timestamptz, 'Cómo pagaste y cuánto llevas', 'Anota si pagaste en efectivo, tarjeta o Nequi y ponle un límite a cada uno.', 'i-wal', 'pagos'),
  ('2026-11-04 12:00-05'::timestamptz, 'Caja fuerte', 'Tus ingresos y tus claves guardados en un solo lugar, protegidos.', 'i-cand', 'caja'),
  ('2026-11-13 12:00-05'::timestamptz, 'Lugares cercanos por WhatsApp', 'Pídele al bot una droguería o un cajero y te manda los más cercanos con la ruta.', 'i-wa', 'whatsapp')
) AS v(publicada_at, titulo, descripcion, icono, pantalla)
WHERE NOT EXISTS (SELECT 1 FROM public.novedades);

COMMIT;
