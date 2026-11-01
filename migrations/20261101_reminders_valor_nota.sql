-- 2026-11-01 — Nueva pestaña Recordatorios (tabla).
-- Cada fila: titulo (qué recordar), recordar_fecha (día del aviso), valor, nota y
-- created_at (fecha de creación). Solo agrega columnas opcionales: las filas
-- existentes quedan iguales, con valor y nota vacíos.
-- Ya aplicada en produccion via MCP.

ALTER TABLE public.reminders
  ADD COLUMN IF NOT EXISTS valor numeric,
  ADD COLUMN IF NOT EXISTS nota text;
