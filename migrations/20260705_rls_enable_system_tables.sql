-- 2026-07-05 — Auditoria RLS: habilitar Row Level Security en las 5 tablas de
-- sistema que estaban EXPUESTAS a la clave anon (cualquiera con la publishable
-- key podia leer/escribir todas las filas).
--
-- Todas son backend-only: el frontend (index.html) nunca las consulta con la
-- clave anon; solo las tocan los endpoints api/*.js, que usan SUPABASE_SERVICE_KEY
-- (lib/supabase.js) y BYPASSEAN RLS. Por eso habilitar RLS SIN politicas es el
-- fix correcto: deniega a anon/authenticated por defecto (deny-all) y el service
-- key sigue funcionando. => "solo accesible por service key".
--
-- Datos sensibles que quedaban expuestos:
--   whatsapp_conversations (468) — historial de chats WhatsApp (PII)
--   whatsapp_alerts        (274) — mensajes + telefonos (PII)
--   whatsapp_state           (3) — telefono, user_id, contexto conversacional
--   config                   (4) — config de la app (sin secretos; API keys viven en profiles)
--   invitaciones             (1) — codigos de invitacion (ademas tabla huerfana, sin uso en el codigo)

ALTER TABLE public.whatsapp_alerts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_state         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.config                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitaciones           ENABLE ROW LEVEL SECURITY;
