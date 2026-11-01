-- 2026-11-01 — Rediseño de Pagos (Fase 1 de la simplificación).
--   1. payments.nota (texto libre) y payments.soporte_url.
--      soporte_url guarda la RUTA del archivo dentro del bucket, no una URL:
--      el bucket es privado y la app pide un enlace firmado temporal al mostrarla.
--   2. Bucket privado "facturas". Rutas: {user_id}/{pago_id}-{timestamp}.jpg
--      RLS: cada usuario solo ve, sube y borra dentro de su propia carpeta.
--   3. El trigger de recurrencia copia la nota al pago del mes siguiente
--      (excepción autorizada por Rubén: solo se agrega "nota" al INSERT).
--      soporte_url NO se copia: la factura es de cada mes.
-- Aplicar ANTES de desplegar el frontend: guardarPago inserta la columna nota.

BEGIN;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS nota text,
  ADD COLUMN IF NOT EXISTS soporte_url text;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('facturas', 'facturas', false, 5242880, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "facturas_select_own" ON storage.objects;
CREATE POLICY "facturas_select_own" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'facturas' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "facturas_insert_own" ON storage.objects;
CREATE POLICY "facturas_insert_own" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'facturas' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "facturas_delete_own" ON storage.objects;
CREATE POLICY "facturas_delete_own" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'facturas' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE OR REPLACE FUNCTION public.crear_pago_recurrente_siguiente()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_dia        int;
  v_next_first date;
  v_next_fecha date;
BEGIN
  -- Solo cuando el pago pasa a 'pagado' (transicion real) y es recurrente.
  IF NEW.status <> 'pagado'
     OR OLD.status IS NOT DISTINCT FROM 'pagado'
     OR COALESCE(NEW.fijo, false) = false
     OR NEW.fecha_limite IS NULL THEN
    RETURN NEW;
  END IF;

  v_dia := EXTRACT(DAY FROM NEW.fecha_limite)::int;
  v_next_first := (date_trunc('month', NEW.fecha_limite) + interval '1 month')::date;

  IF v_dia >= 29 THEN
    -- Ultimo dia del mes destino
    v_next_fecha := (date_trunc('month', NEW.fecha_limite) + interval '2 month' - interval '1 day')::date;
  ELSE
    v_next_fecha := v_next_first + (v_dia - 1);
  END IF;

  -- Guard anti-duplicado: no crear si ya existe ese pago para esa fecha.
  IF EXISTS (
    SELECT 1 FROM payments
    WHERE user_id = NEW.user_id
      AND nombre = NEW.nombre
      AND fecha_limite = v_next_fecha
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO payments (user_id, nombre, monto, fecha_limite, categoria, account_id, fijo, status, nota)
  VALUES (NEW.user_id, NEW.nombre, NEW.monto, v_next_fecha, NEW.categoria, NEW.account_id, true, 'pendiente', NEW.nota);

  RETURN NEW;
END;
$$;

COMMIT;
