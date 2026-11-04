-- 2026-11-04 — La pestaña Recordatorios pasa a ser "Caja": Ingresos y Claves.
--   1. ingresos: lo que le entra al usuario. medio, de_quien y motivo son opcionales; la
--      fecha es hoy si no se dice. soportes guarda rutas del bucket privado "facturas".
--   2. profiles.tope_banco / tope_nequi / tope_efectivo: tope mensual. Vacío = sin tope.
--   3. ingresos_tope_avisos: un WhatsApp por usuario, mes, medio y nivel (80 o 100).
--      Solo la usa el backend (service key): RLS sin políticas = nadie más la ve.
--   4. Recordatorios con fecha y aviso pendiente pasan a la Agenda como eventos, con la
--      nota y el valor en la nota. Se les apaga el aviso para que no salga dos veces.
--      Nada se borra: los demás recordatorios quedan en la base sin mostrarse.
-- Aplicar ANTES de desplegar.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ingresos (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  monto      numeric NOT NULL CHECK (monto > 0),
  medio      text CHECK (medio IN ('banco','nequi','efectivo')),
  de_quien   text CHECK (char_length(de_quien) <= 120),
  motivo     text CHECK (char_length(motivo) <= 200),
  fecha      date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Bogota')::date,
  soportes   text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingresos_user_fecha_idx ON public.ingresos (user_id, fecha);
ALTER TABLE public.ingresos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ingresos_own ON public.ingresos;
CREATE POLICY ingresos_own ON public.ingresos FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS tope_banco    numeric CHECK (tope_banco > 0),
  ADD COLUMN IF NOT EXISTS tope_nequi    numeric CHECK (tope_nequi > 0),
  ADD COLUMN IF NOT EXISTS tope_efectivo numeric CHECK (tope_efectivo > 0);

CREATE TABLE IF NOT EXISTS public.ingresos_tope_avisos (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mes        text NOT NULL,             -- 'YYYY-MM' en hora de Colombia
  medio      text NOT NULL CHECK (medio IN ('banco','nequi','efectivo')),
  nivel      smallint NOT NULL CHECK (nivel IN (80, 100)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mes, medio, nivel)
);
ALTER TABLE public.ingresos_tope_avisos ENABLE ROW LEVEL SECURITY;

-- Recordatorios con aviso pendiente → Agenda.
WITH movidos AS (
  UPDATE public.reminders
  SET avisar = false,
      extras = COALESCE(extras, '{}'::jsonb) || jsonb_build_object('pasado_a_agenda', true)
  WHERE tipo IN ('nota', 'definicion')
    AND recordar_fecha >= (now() AT TIME ZONE 'America/Bogota')::date
    AND COALESCE(avisar, true)
    AND NOT COALESCE(hecho, false)
    AND NOT COALESCE(notificado, false)
  RETURNING user_id, titulo, recordar_fecha, valor, nota
)
INSERT INTO public.events (user_id, titulo, fecha, nota)
SELECT user_id,
       COALESCE(NULLIF(btrim(titulo), ''), 'Recordatorio'),
       recordar_fecha,
       NULLIF(concat_ws(' · ',
         NULLIF(btrim(nota), ''),
         CASE WHEN valor IS NOT NULL THEN 'Valor: $' || replace(to_char(round(valor), 'FM999,999,999,999'), ',', '.') END
       ), '')
FROM movidos;

COMMIT;
