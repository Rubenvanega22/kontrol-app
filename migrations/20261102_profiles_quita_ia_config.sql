-- 2026-11-02 — Quita de profiles ia_proveedor, ia_modelo e ia_nombre.
-- Ningún código, función, vista ni política las usa, y todas las filas tenían su valor por
-- defecto: nadie escribió nada. El asistente siempre es Ana y usa las claves del servidor.
-- La migración se aborta si alguna fila tiene otro valor.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE ia_proveedor IS DISTINCT FROM 'groq'
       OR ia_modelo IS DISTINCT FROM 'llama-3.3-70b-versatile'
       OR ia_nombre IS DISTINCT FROM 'Ana'
  ) THEN
    RAISE EXCEPTION 'Hay valores distintos al de por defecto en profiles: no se borra nada';
  END IF;
END;
$$;

ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS ia_proveedor,
  DROP COLUMN IF EXISTS ia_modelo,
  DROP COLUMN IF EXISTS ia_nombre;
