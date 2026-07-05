-- 2026-07-05 — Permitir eliminar cajas que tienen movimientos.
-- Antes: caja_movimientos.caja_id -> cajas.id con ON DELETE NO ACTION,
-- por lo que borrar una caja con historial fallaba con violación de FK.
-- Ahora: ON DELETE CASCADE (coherente con caja_entries), el historial se
-- borra junto con la caja. Ya aplicada en producción vía MCP.

ALTER TABLE caja_movimientos
  DROP CONSTRAINT caja_movimientos_caja_id_fkey,
  ADD CONSTRAINT caja_movimientos_caja_id_fkey
    FOREIGN KEY (caja_id) REFERENCES cajas(id) ON DELETE CASCADE;
