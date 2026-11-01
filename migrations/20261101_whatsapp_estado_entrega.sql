-- 2026-11-01 — WhatsApp: estado real de entrega por status callback de Twilio.
-- whatsapp_alerts.estado: pendiente → enviando → aceptado → entregado, o bien
-- en_espera (sandbox vencido), fallido, descartado o caducado.
-- Los avisos ya enviados quedan como "aceptado": de ellos no se sabe si se entregaron.
-- Ya aplicada en produccion via MCP.

ALTER TABLE public.whatsapp_alerts
  ADD COLUMN IF NOT EXISTS estado text NOT NULL DEFAULT 'pendiente',
  ADD COLUMN IF NOT EXISTS twilio_sid text,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS intentos integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ultimo_intento_at timestamptz;

UPDATE public.whatsapp_alerts SET estado = 'aceptado' WHERE enviado = true;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_alerts_twilio_sid_key
  ON public.whatsapp_alerts (twilio_sid) WHERE twilio_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS whatsapp_alerts_estado_idx
  ON public.whatsapp_alerts (estado, telefono)
  WHERE estado IN ('pendiente', 'enviando', 'en_espera', 'fallido');

-- whatsapp_vencido_at: Twilio devolvió 63015. whatsapp_prueba_at: cuándo se envió el
-- mensaje que confirma una renovación.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS whatsapp_vencido_at timestamptz,
  ADD COLUMN IF NOT EXISTS whatsapp_prueba_at timestamptz;
