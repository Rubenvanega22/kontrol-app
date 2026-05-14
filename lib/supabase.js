const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

// Cliente Supabase con service role para uso server-side.
// - `transport: ws` resuelve el crash de Node 20 sin WebSocket nativo
//   (sin esto el cliente revienta al cargar el módulo).
// - Sesión persistente desactivada (esto es servidor, no navegador).
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws }
  }
);

module.exports = supabase;
