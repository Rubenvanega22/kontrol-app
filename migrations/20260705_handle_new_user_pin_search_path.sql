-- 2026-07-05 — Advisory 0011 (function_search_path_mutable) en handle_new_user.
-- Fija search_path a '' para que no dependa del search_path del caller.
-- El cuerpo ya cualifica public.profiles; pg_catalog sigue implicito para
-- builtins (split_part/coalesce), asi que '' es seguro. ALTER FUNCTION SET no
-- altera el ACL (los REVOKE de anon/authenticated se conservan).
-- Ya aplicada en produccion via MCP.

ALTER FUNCTION public.handle_new_user() SET search_path = '';
