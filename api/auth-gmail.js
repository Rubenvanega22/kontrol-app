// /api/auth-gmail.js
// Inicia el flujo OAuth para conectar Gmail.
// Si se pasa ?user_id=UUID, se embebe en el state para asociar la cuenta al usuario.

const { google } = require('googleapis');
const { signState } = require('../lib/oauth-state');

module.exports = async function handler(req, res) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );

  const scopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/userinfo.email'
  ];

  const userId = (req.query.user_id || '').trim();
  // Payload: "gmail" o "gmail:<userId>". Se firma con HMAC para que el
  // callback rechace cualquier intento de manipular el user_id.
  const payload = userId ? `gmail:${userId}` : 'gmail';
  let state;
  try {
    state = signState(payload);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
    state
  });

  res.redirect(url);
};
