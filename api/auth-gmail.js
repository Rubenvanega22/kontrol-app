// /api/auth-gmail.js
// Inicia el flujo OAuth para conectar Gmail.
// Si se pasa ?user_id=UUID, se embebe en el state para asociar la cuenta al usuario.

const { google } = require('googleapis');

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
  // El state lleva el user_id para que el callback lo asocie a la cuenta.
  // Formato: "gmail:UUID" o solo "gmail" si no se pasa.
  const state = userId ? `gmail:${userId}` : (req.query.state || 'gmail');

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
    state
  });

  res.redirect(url);
};
