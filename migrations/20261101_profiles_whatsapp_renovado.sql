-- 2026-11-01 — Sandbox de Twilio: la sesión vence 3 días después del join.
-- Guarda cuándo tocó el usuario "Renovar WhatsApp". Twilio atiende el join por su cuenta
-- y no avisa al webhook, así que esta es la mejor señal disponible, no una confirmación.
-- Ya aplicada en produccion via MCP.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS whatsapp_renovado_at timestamptz;
