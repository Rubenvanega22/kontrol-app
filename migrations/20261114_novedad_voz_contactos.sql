-- 2026-11-14 — Novedad: en los audios el bot reconoce mejor los nombres de tus contactos
-- (Whisper recibe sus nombres) y, si duda, pregunta "¿Te refieres a…?".
-- Aplicar DESPUÉS de desplegar (commit a0f9f31).

INSERT INTO public.novedades (publicada_at, titulo, descripcion, icono, pantalla)
SELECT now(), 'El bot entiende mejor los nombres',
       'En tus audios reconoce los nombres de tus contactos y, si duda, te pregunta a quién.',
       'i-user', 'whatsapp'
WHERE NOT EXISTS (SELECT 1 FROM public.novedades WHERE titulo = 'El bot entiende mejor los nombres');
