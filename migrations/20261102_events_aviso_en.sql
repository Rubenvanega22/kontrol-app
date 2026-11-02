-- El aviso elegido puede ser "2 horas antes" o "el día anterior a las 6 pm": se guarda el
-- momento exacto. Vacío = los avisos normales. notificado_aviso marca que ya salió.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS aviso_en timestamptz;

UPDATE public.events
SET aviso_en = ((CASE WHEN aviso_hora <= hora THEN fecha ELSE fecha - 1 END) + aviso_hora) AT TIME ZONE 'America/Bogota'
WHERE aviso_hora IS NOT NULL AND hora IS NOT NULL AND aviso_en IS NULL;
