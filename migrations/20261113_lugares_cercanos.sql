-- 2026-11-13 — Búsqueda de lugares cercanos por WhatsApp (Google Places).
--   1. profiles.ubicacion_lat / ubicacion_lng / ubicacion_at: la última ubicación que
--      el usuario compartió por WhatsApp. Se usa solo si tiene 30 minutos o menos.
--   2. profiles.busqueda_pendiente: la búsqueda que quedó esperando la ubicación
--      ({consulta, tipo, at}). No va en whatsapp_state porque los flujos de pagos
--      sobrescriben esa fila.
--   3. busquedas_lugares: una fila por llamada a Google Places, para los topes diarios
--      (20 por usuario, 33 en total). Solo la usa el backend (service key): RLS sin
--      políticas = nadie más la ve.
-- Aplicar ANTES de desplegar.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ubicacion_lat      double precision CHECK (ubicacion_lat BETWEEN -90 AND 90),
  ADD COLUMN IF NOT EXISTS ubicacion_lng      double precision CHECK (ubicacion_lng BETWEEN -180 AND 180),
  ADD COLUMN IF NOT EXISTS ubicacion_at       timestamptz,
  ADD COLUMN IF NOT EXISTS busqueda_pendiente jsonb;

CREATE TABLE IF NOT EXISTS public.busquedas_lugares (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  consulta   text CHECK (char_length(consulta) <= 200),
  tipo       text CHECK (char_length(tipo) <= 60),
  resultados smallint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS busquedas_lugares_created_idx ON public.busquedas_lugares (created_at);
CREATE INDEX IF NOT EXISTS busquedas_lugares_user_created_idx ON public.busquedas_lugares (user_id, created_at);
ALTER TABLE public.busquedas_lugares ENABLE ROW LEVEL SECURITY;

COMMIT;
