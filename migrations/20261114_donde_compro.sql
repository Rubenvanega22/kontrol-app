-- 2026-11-14 — "¿Dónde compro esto?" con una foto por WhatsApp.
--   1. profiles.ultima_foto: la última foto que el usuario mandó por WhatsApp
--      ({url, ct, at}; url = dirección de Twilio, no el archivo). Sirve si pregunta
--      "¿dónde compro esto?" con un audio o un texto aparte, hasta 10 minutos después.
--   2. La novedad de la función (regla: cada cambio visible lleva su novedad).
-- Las búsquedas cuentan en busquedas_lugares con los mismos topes (20 por usuario, 33 en total).
-- Aplicar ANTES de desplegar (la novedad, después).

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ultima_foto jsonb;

INSERT INTO public.novedades (publicada_at, titulo, descripcion, icono, pantalla)
SELECT now(), '¿Dónde compro esto?',
       'Mándale al bot la foto de un producto y te dice qué tiendas cerca lo venden.',
       'i-cam', 'whatsapp'
WHERE NOT EXISTS (SELECT 1 FROM public.novedades WHERE titulo = '¿Dónde compro esto?');

COMMIT;
