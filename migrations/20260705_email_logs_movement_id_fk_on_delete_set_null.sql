-- 2026-07-05 — Permitir borrar movimientos que vinieron del sync de correos.
-- Antes: email_logs.movement_id -> movements.id con ON DELETE NO ACTION, por lo
-- que borrar un movimiento referenciado por un email_log fallaba con violacion
-- de FK (afectaba a ~30 de 31 movimientos). Por eso "borrar actividad reciente"
-- no funcionaba.
-- Ahora: ON DELETE SET NULL. NO usamos CASCADE a proposito: el sync deduplica
-- por email_message_id, asi que el email_log debe sobrevivir (con procesado=true)
-- para no re-importar el movimiento borrado; solo se limpia el puntero colgante.
-- Ya aplicada en produccion via MCP.

ALTER TABLE email_logs
  DROP CONSTRAINT email_logs_movement_id_fkey,
  ADD CONSTRAINT email_logs_movement_id_fkey
    FOREIGN KEY (movement_id) REFERENCES movements(id) ON DELETE SET NULL;
