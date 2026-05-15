// /api/test-gmail.js
// Debug endpoint — lista los últimos correos del Gmail del usuario SIN ningún filtro.
// Sirve para descubrir el remitente real que usan los bancos (Bancolombia, Nequi, etc.)
// y compararlo contra los strings hardcodeados en lib/email-parser.js → BANCOS.
//
// Uso desde la app:
//   const { data: { session } } = await supa.auth.getSession();
//   fetch('/api/test-gmail?limit=20', {
//     headers: { Authorization: 'Bearer ' + session.access_token }
//   }).then(r => r.json()).then(console.log);

const { google } = require('googleapis');
const supabase = require('../lib/supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Token requerido',
      hint: 'Llama el endpoint con header "Authorization: Bearer <supabase-jwt>". Desde la app, usa await supa.auth.getSession().'
    });
  }

  const token = authHeader.slice(7);
  const { data: authData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !authData?.user) return res.status(401).json({ error: 'Token inválido' });
  const userId = authData.user.id;

  const limit = Math.min(Math.max(parseInt((req.query && req.query.limit) || '20', 10) || 20, 1), 50);
  const query = (req.query && typeof req.query.q === 'string') ? req.query.q : null;

  try {
    const { data: accounts, error } = await supabase
      .from('email_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('tipo', 'gmail')
      .eq('activo', true);

    if (error) return res.status(500).json({ error: error.message });
    if (!accounts || !accounts.length) {
      return res.json({
        ok: false,
        message: 'No tienes cuenta Gmail activa en email_accounts.',
        user_id: userId
      });
    }

    const results = [];

    for (const account of accounts) {
      try {
        const oauth2Client = new google.auth.OAuth2(
          process.env.GMAIL_CLIENT_ID,
          process.env.GMAIL_CLIENT_SECRET,
          process.env.GMAIL_REDIRECT_URI
        );
        oauth2Client.setCredentials({
          access_token: account.access_token,
          refresh_token: account.refresh_token,
        });

        // Refresh para asegurar token válido
        const { credentials } = await oauth2Client.refreshAccessToken();
        if (credentials.access_token !== account.access_token) {
          await supabase.from('email_accounts').update({
            access_token: credentials.access_token,
            token_expiry: new Date(credentials.expiry_date).toISOString()
          }).eq('id', account.id);
        }

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        // Sin filtro: lista los últimos N correos. Si vino ?q=... se respeta.
        const listOpts = { userId: 'me', maxResults: limit };
        if (query) listOpts.q = query;
        const listRes = await gmail.users.messages.list(listOpts);
        const messages = listRes.data.messages || [];

        const emails = [];
        for (const msg of messages) {
          // metadata-only: barato, no descarga el body
          const full = await gmail.users.messages.get({
            userId: 'me', id: msg.id, format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date', 'Return-Path']
          });
          const headers = full.data.payload?.headers || [];
          const getH = (name) => headers.find(h => h.name === name)?.value || '';
          emails.push({
            id: msg.id,
            from: getH('From'),
            return_path: getH('Return-Path'),
            subject: getH('Subject'),
            date: getH('Date'),
            snippet: full.data.snippet || ''
          });
        }

        results.push({
          account_email: account.email,
          count: emails.length,
          query_aplicada: query || '(sin filtro — últimos N correos)',
          emails
        });
      } catch (e) {
        console.error('[test-gmail] account error', account.email, e.message);
        results.push({
          account_email: account.email,
          error: e.message
        });
      }
    }

    return res.json({
      ok: true,
      user_id: userId,
      limit,
      accounts: results,
      hint: 'Compara el campo "from" con BANCOS.<banco>.remitentes en lib/email-parser.js. Si difiere, ahí está el bug.'
    });
  } catch (e) {
    console.error('[test-gmail] uncaught:', e);
    return res.status(500).json({ error: e.message });
  }
};
