-- 2026-11-01 — Recordatorios: marcar una fila como hecha.
-- Una fila hecha se conserva como registro, no genera aviso y se puede desmarcar.
-- Todas las filas existentes quedan sin hacer.
-- Ya aplicada en produccion via MCP.

ALTER TABLE public.reminders
  ADD COLUMN IF NOT EXISTS hecho boolean NOT NULL DEFAULT false;
