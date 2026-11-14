-- 2026-11-14 — Mensajes programados: "a las 6:05 escríbele a Paola: ya voy en camino".
--   1. contactos: nombre y número (E.164) de las personas a las que el usuario le escribe.
--      Se llenan por WhatsApp (el bot pide el número una sola vez) o en la app
--      (Perfil → Mis contactos, con "Elegir de mis contactos" del teléfono).
--   2. events.tipo = 'mensaje' (la columna ya existía, default 'evento') + contacto_id: el mensaje se ve en la Agenda como
--      "Mensaje a Paola", con el texto en nota. Borrar el contacto deja el evento sin
--      número (SET NULL) en vez de bloquear el borrado.
--   3. events.notificado_mensaje: el aviso a la hora ya salió (lo reclama el cron).
--   4. La novedad de la función (regla: cada cambio visible lleva su novedad).
-- Aplicar ANTES de desplegar.

BEGIN;

CREATE TABLE IF NOT EXISTS public.contactos (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  nombre     text NOT NULL CHECK (char_length(btrim(nombre)) BETWEEN 1 AND 60),
  telefono   text NOT NULL CHECK (telefono ~ '^\+[0-9]{8,15}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS contactos_user_nombre_unique ON public.contactos (user_id, lower(nombre));

ALTER TABLE public.contactos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "contactos propios" ON public.contactos;
CREATE POLICY "contactos propios" ON public.contactos
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- events.tipo ya existía (text, default 'evento'); 'mensaje' es el valor nuevo.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS contacto_id        bigint REFERENCES public.contactos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notificado_mensaje boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS events_mensajes_pendientes_idx ON public.events (fecha)
  WHERE tipo = 'mensaje' AND notificado_mensaje = false;
CREATE INDEX IF NOT EXISTS events_contacto_idx ON public.events (contacto_id) WHERE contacto_id IS NOT NULL;

INSERT INTO public.novedades (publicada_at, titulo, descripcion, icono, pantalla)
SELECT now(), 'Mensajes a la hora que digas',
       'Dile al bot "a las 6 escríbele a Paola: ya voy" y a esa hora te pasa el chat listo.',
       'i-wa', 'whatsapp'
WHERE NOT EXISTS (SELECT 1 FROM public.novedades WHERE titulo = 'Mensajes a la hora que digas');

COMMIT;
