-- 2026-11-03 — Pagos: medio de pago, varias fotos de soporte y límites por medio.
--   1. payments.medio_pago: efectivo | tarjeta | nequi. Vacío = "Sin medio" (los pagados antes).
--   2. payments.soportes: rutas de las fotos dentro del bucket privado "facturas".
--      Reemplaza a soporte_url (una sola foto), que se copia aquí y se deja por compatibilidad
--      con apps viejas en caché; la app nueva lee las dos.
--   3. profiles.limite_efectivo / limite_tarjeta / limite_nequi: límite mensual. Vacío = sin límite.
--   4. pagos_limite_avisos: un aviso por usuario, mes, medio y nivel (80 o 100). La clave
--      primaria hace que el WhatsApp salga una sola vez al mes aunque dos procesos lo intenten.
--      Solo la usa el backend (service key): RLS sin políticas = nadie más la ve.
-- Aplicar ANTES de desplegar.

BEGIN;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS medio_pago text,
  ADD COLUMN IF NOT EXISTS soportes text[] NOT NULL DEFAULT '{}';

DO $$ BEGIN
  ALTER TABLE public.payments
    ADD CONSTRAINT payments_medio_pago_check CHECK (medio_pago IN ('efectivo','tarjeta','nequi'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE public.payments
SET soportes = ARRAY[soporte_url]
WHERE soporte_url IS NOT NULL AND NOT (soporte_url = ANY (soportes));

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS limite_efectivo numeric CHECK (limite_efectivo > 0),
  ADD COLUMN IF NOT EXISTS limite_tarjeta  numeric CHECK (limite_tarjeta > 0),
  ADD COLUMN IF NOT EXISTS limite_nequi    numeric CHECK (limite_nequi > 0);

CREATE TABLE IF NOT EXISTS public.pagos_limite_avisos (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mes        text NOT NULL,             -- 'YYYY-MM' en hora de Colombia
  medio      text NOT NULL CHECK (medio IN ('efectivo','tarjeta','nequi')),
  nivel      smallint NOT NULL CHECK (nivel IN (80, 100)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mes, medio, nivel)
);
ALTER TABLE public.pagos_limite_avisos ENABLE ROW LEVEL SECURITY;

COMMIT;
