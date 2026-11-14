-- 2026-11-14 — Novedad: compartir un contacto del celular a Kontrol (Web Share Target).
-- Aplicar DESPUÉS de desplegar.

INSERT INTO public.novedades (publicada_at, titulo, descripcion, icono, pantalla)
SELECT now(), 'Comparte un contacto a Kontrol',
       'En Contactos abre a alguien, toca Compartir y elige Kontrol: se guarda solo.',
       'i-user', 'inicio'
WHERE NOT EXISTS (SELECT 1 FROM public.novedades WHERE titulo = 'Comparte un contacto a Kontrol');
