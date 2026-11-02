-- 2026-11-02 — Quita de profiles las columnas ia_api_key_*.
-- Ningún código las usa y estaban vacías en todas las filas. Tampoco dependen de ellas
-- funciones, vistas ni políticas. Guardar claves aquí no tenía sentido: la regla de
-- administrador permite leer todas las filas de profiles.
-- La migración se aborta si alguna llegó a tener un valor.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE nullif(ia_api_key_claude, '') IS NOT NULL
       OR nullif(ia_api_key_gemini, '') IS NOT NULL
       OR nullif(ia_api_key_groq, '') IS NOT NULL
       OR nullif(ia_api_key_openai, '') IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Hay claves guardadas en profiles: no se borra nada';
  END IF;
END;
$$;

ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS ia_api_key_claude,
  DROP COLUMN IF EXISTS ia_api_key_gemini,
  DROP COLUMN IF EXISTS ia_api_key_groq,
  DROP COLUMN IF EXISTS ia_api_key_openai;
