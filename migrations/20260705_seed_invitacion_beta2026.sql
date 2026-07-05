-- 2026-07-05 — Sembrar el codigo de invitacion BETA2026 en `invitaciones`.
-- RUBEN2026 ya existia (usos_maximos=50). Ahora la validacion de registro corre
-- en el backend (api/validar-invitacion.js) contra esta tabla, en vez de un
-- array hardcodeado en el frontend. Idempotente: no duplica si ya existe.
-- Ya aplicada en produccion via MCP.

INSERT INTO public.invitaciones (codigo, activo, usos_maximos, usos_actuales, nota)
SELECT 'BETA2026', true, 50, 0, 'Código beta'
WHERE NOT EXISTS (SELECT 1 FROM public.invitaciones WHERE codigo = 'BETA2026');
