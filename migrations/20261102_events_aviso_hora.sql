-- Eventos antes de las 8 am: hora de aviso elegida por el usuario.
-- notificado_aviso marca ese aviso, o el de las 8 pm de la víspera si no eligió hora.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS aviso_hora time without time zone,
  ADD COLUMN IF NOT EXISTS notificado_aviso boolean NOT NULL DEFAULT false;
