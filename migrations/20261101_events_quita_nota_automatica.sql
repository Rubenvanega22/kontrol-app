-- 2026-11-01 — Agenda: la nota de un evento ahora sale en los avisos de WhatsApp.
-- La columna events.nota ya existía. La IA escribía ahí la etiqueta interna
-- "Creado por IA", que no es una nota del usuario y saldría como "📝 Nota: Creado por IA".
-- Se limpia solo esa etiqueta; las notas escritas por usuarios no se tocan.
-- Ya aplicada en produccion via MCP.

UPDATE public.events SET nota = NULL WHERE nota = 'Creado por IA';
