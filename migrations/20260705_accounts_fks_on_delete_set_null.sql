-- 2026-07-05 — Permitir borrar cuentas conservando el historial financiero.
-- Antes: movements.account_id y payments.account_id -> accounts.id con
-- ON DELETE NO ACTION, por lo que borrar una cuenta con movimientos/pagos
-- fallaba con violacion de FK (mismo patron que cajas y email_logs).
-- Ahora: ON DELETE SET NULL. NO se usa CASCADE a proposito: movements es el
-- libro contable y payments son pagos programados; deben sobrevivir. Al borrar
-- la cuenta quedan "Sin cuenta asociada" (account_id NULL), estado ya soportado
-- por el frontend. Ya aplicada en produccion via MCP.

ALTER TABLE movements
  DROP CONSTRAINT movements_account_id_fkey,
  ADD CONSTRAINT movements_account_id_fkey
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL;

ALTER TABLE payments
  DROP CONSTRAINT payments_account_id_fkey,
  ADD CONSTRAINT payments_account_id_fkey
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL;
