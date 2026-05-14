// /api/auth-callback.js
// Recibe el código OAuth de Google/Microsoft y guarda tokens.
// Diseñado para NUNCA producir un 500 — cualquier error redirige al frontend
// con un mensaje en ?auth_error=... para que el usuario sepa qué pasó.

const { google } = require('googleapis');
const supabase = require('../lib/supabase');
const { verifyState } = require('../lib/oauth-state');

// Convierte cualquier valor a ISO 8601 válido o null.
// Si tokens.expiry_date llega como string/NaN/Infinity, NO lanza — devuelve null.
function safeIsoDate(value){
  if (value === null || value === undefined || value === '') return null;
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch (_) {
    return null;
  }
}

function safeRedirect(res, location){
  try { return res.redirect(location); }
  catch (_) {
    try {
      return res.status(302).setHeader('Location', location).end();
    } catch (_) {
      return res.status(500).json({ error: 'No se pudo redirigir', location });
    }
  }
}

function errorRedirect(res, msg){
  return safeRedirect(res, '/?auth_error=' + encodeURIComponent(String(msg || 'Error desconocido').slice(0, 300)));
}

module.exports = async function handler(req, res) {
  try {
    // Vercel a veces entrega query params repetidos como array — normalizar a string.
    const q = req.query || {};
    const code = Array.isArray(q.code) ? q.code[0] : q.code;
    const state = Array.isArray(q.state) ? q.state[0] : q.state;
    const oauthError = Array.isArray(q.error) ? q.error[0] : q.error;

    console.log('[auth-callback] start', {
      hasCode: !!code,
      stateLen: state ? state.length : 0,
      oauthError: oauthError || null
    });

    if (oauthError) {
      console.log('[auth-callback] OAuth provider error:', oauthError);
      return errorRedirect(res, oauthError);
    }
    if (!code) {
      console.log('[auth-callback] no code in query');
      return errorRedirect(res, 'Sin código de autorización');
    }

    // ── Verificar firma HMAC del state ──
    let payload;
    try {
      payload = verifyState(state);
    } catch (e) {
      console.error('[auth-callback] verifyState threw:', e.message);
      return errorRedirect(res, 'Error verificando state: ' + e.message);
    }
    if (!payload) {
      console.log('[auth-callback] invalid state signature');
      return errorRedirect(res, 'Estado OAuth inválido o manipulado');
    }

    const payloadParts = String(payload).split(':');
    const provider = payloadParts[0] || '';
    const userId = (payloadParts[1] || '').trim() || null;
    console.log('[auth-callback] payload ok, provider=', provider, 'hasUserId=', !!userId);

    // ── Gmail ──
    if (provider === 'gmail') {
      if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REDIRECT_URI) {
        console.error('[auth-callback] missing Gmail OAuth env vars');
        return errorRedirect(res, 'Configuración OAuth Gmail incompleta en el servidor');
      }

      let oauth2Client;
      try {
        oauth2Client = new google.auth.OAuth2(
          process.env.GMAIL_CLIENT_ID,
          process.env.GMAIL_CLIENT_SECRET,
          process.env.GMAIL_REDIRECT_URI
        );
      } catch (e) {
        console.error('[auth-callback] OAuth2 ctor failed:', e.message);
        return errorRedirect(res, 'Error inicializando cliente OAuth: ' + e.message);
      }

      let tokens;
      try {
        const result = await oauth2Client.getToken(code);
        tokens = result.tokens || {};
      } catch (e) {
        console.error('[auth-callback] getToken failed:', e.message);
        return errorRedirect(res, 'Error intercambiando código: ' + e.message);
      }

      if (!tokens.access_token) {
        console.error('[auth-callback] no access_token in response', tokens);
        return errorRedirect(res, 'Google no devolvió access_token');
      }

      try { oauth2Client.setCredentials(tokens); } catch (_) {}

      let email = null;
      try {
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const resp = await oauth2.userinfo.get();
        email = resp && resp.data ? resp.data.email : null;
      } catch (e) {
        console.error('[auth-callback] userinfo.get failed:', e.message);
        return errorRedirect(res, 'Error obteniendo email del usuario: ' + e.message);
      }

      if (!email) {
        console.error('[auth-callback] userinfo did not return email');
        return errorRedirect(res, 'Google no devolvió el email');
      }

      const row = {
        email,
        tipo: 'gmail',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || null,
        token_expiry: safeIsoDate(tokens.expiry_date),
        activo: true
      };
      if (userId) row.user_id = userId;

      console.log('[auth-callback] saving row', {
        email,
        tipo: 'gmail',
        hasAccessToken: !!row.access_token,
        hasRefreshToken: !!row.refresh_token,
        token_expiry: row.token_expiry,
        user_id: row.user_id || null
      });

      // SELECT-then-UPDATE/INSERT manual — funciona sin importar qué UNIQUE constraints
      // existan en la tabla. Evita el error "no unique constraint matching ON CONFLICT".
      try {
        // 1. Buscar si ya existe una fila para este email + user_id
        let findQuery = supabase.from('email_accounts').select('id').eq('email', email);
        if (userId) findQuery = findQuery.eq('user_id', userId);
        else findQuery = findQuery.is('user_id', null);

        const { data: existing, error: findError } = await findQuery.maybeSingle();
        if (findError) {
          console.error('[auth-callback] select existing failed:', JSON.stringify(findError));
          return errorRedirect(res, `Error consultando cuenta: [${findError.code || '?'}] ${findError.message}`);
        }

        let writeError;
        if (existing && existing.id) {
          // Actualizar existente — preserva refresh_token previo si Google no devuelve uno nuevo
          const updateRow = { ...row };
          if (!updateRow.refresh_token) delete updateRow.refresh_token;
          const { error } = await supabase.from('email_accounts').update(updateRow).eq('id', existing.id);
          writeError = error;
          console.log('[auth-callback] updated existing row id=', existing.id);
        } else {
          const { error } = await supabase.from('email_accounts').insert(row);
          writeError = error;
          console.log('[auth-callback] inserted new row');
        }

        if (writeError) {
          console.error('[auth-callback] write error:', JSON.stringify({
            message: writeError.message, code: writeError.code,
            details: writeError.details, hint: writeError.hint
          }));
          return errorRedirect(res, `Error guardando cuenta: [${writeError.code || '?'}] ${writeError.message}${writeError.hint ? ' — ' + writeError.hint : ''}`);
        }
      } catch (e) {
        console.error('[auth-callback] supabase threw:', e.stack || e.message);
        return errorRedirect(res, 'Error de base de datos: ' + e.message);
      }

      console.log('[auth-callback] ✓ Gmail connected:', email, 'user_id=', userId || 'none');
      return safeRedirect(res, '/?auth_success=gmail&email=' + encodeURIComponent(email));
    }

    // ── Outlook ──
    if (provider === 'outlook') {
      if (!process.env.OUTLOOK_CLIENT_ID || !process.env.OUTLOOK_CLIENT_SECRET || !process.env.OUTLOOK_REDIRECT_URI) {
        return errorRedirect(res, 'Configuración OAuth Outlook incompleta en el servidor');
      }

      let tokens;
      try {
        const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.OUTLOOK_CLIENT_ID,
            client_secret: process.env.OUTLOOK_CLIENT_SECRET,
            code,
            redirect_uri: process.env.OUTLOOK_REDIRECT_URI,
            grant_type: 'authorization_code'
          })
        });
        tokens = await tokenRes.json();
        if (!tokens.access_token) {
          return errorRedirect(res, 'Outlook no devolvió token: ' + (tokens.error_description || JSON.stringify(tokens).slice(0, 200)));
        }
      } catch (e) {
        return errorRedirect(res, 'Error intercambiando código Outlook: ' + e.message);
      }

      let email = null;
      try {
        const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
          headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        const profile = await profileRes.json();
        email = profile.mail || profile.userPrincipalName || null;
      } catch (e) {
        return errorRedirect(res, 'Error obteniendo perfil Outlook: ' + e.message);
      }

      if (!email) return errorRedirect(res, 'Outlook no devolvió email');

      const row = {
        email, tipo: 'outlook',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || null,
        token_expiry: tokens.expires_in ? safeIsoDate(Date.now() + Number(tokens.expires_in) * 1000) : null,
        activo: true
      };
      if (userId) row.user_id = userId;

      try {
        let findQuery = supabase.from('email_accounts').select('id').eq('email', email);
        if (userId) findQuery = findQuery.eq('user_id', userId);
        else findQuery = findQuery.is('user_id', null);
        const { data: existing, error: findError } = await findQuery.maybeSingle();
        if (findError) return errorRedirect(res, `Error consultando cuenta: [${findError.code || '?'}] ${findError.message}`);

        let writeError;
        if (existing && existing.id) {
          const updateRow = { ...row };
          if (!updateRow.refresh_token) delete updateRow.refresh_token;
          const { error } = await supabase.from('email_accounts').update(updateRow).eq('id', existing.id);
          writeError = error;
        } else {
          const { error } = await supabase.from('email_accounts').insert(row);
          writeError = error;
        }
        if (writeError) return errorRedirect(res, `Error guardando cuenta: [${writeError.code || '?'}] ${writeError.message}`);
      } catch (e) {
        return errorRedirect(res, 'Error de base de datos: ' + e.message);
      }

      return safeRedirect(res, '/?auth_success=outlook&email=' + encodeURIComponent(email));
    }

    return errorRedirect(res, 'Provider OAuth desconocido: ' + provider);

  } catch (err) {
    // Red de seguridad final: NUNCA debería llegar acá, pero por si acaso.
    console.error('[auth-callback] UNCAUGHT:', err && err.stack || err);
    return errorRedirect(res, 'Error interno: ' + (err && err.message ? err.message : String(err)));
  }
};
