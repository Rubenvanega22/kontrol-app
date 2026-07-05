-- 2026-07-05 — Pagos recurrentes mensuales.
-- Al marcar un pago con fijo=true como 'pagado', crea automaticamente el mismo
-- pago para el mes siguiente conservando el dia del mes.
-- Regla meses cortos: dias 29-31 -> SIEMPRE el ultimo dia del mes destino.
-- Se implementa como trigger para cubrir los dos caminos que marcan pagado:
--   web (RPC registrar_pago) y WhatsApp (UPDATE payments SET status='pagado').
-- Ya aplicada en produccion via MCP.

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

  INSERT INTO payments (user_id, nombre, monto, fecha_limite, categoria, account_id, fijo, status)
  VALUES (NEW.user_id, NEW.nombre, NEW.monto, v_next_fecha, NEW.categoria, NEW.account_id, true, 'pendiente');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pago_recurrente ON public.payments;
CREATE TRIGGER trg_pago_recurrente
  AFTER UPDATE OF status ON public.payments
  FOR EACH ROW
  EXECUTE FUNCTION public.crear_pago_recurrente_siguiente();
