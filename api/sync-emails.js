// /api/sync-emails.js
// Se ejecuta cada 5 minutos automáticamente (Vercel Cron)
// Lee Gmail + Outlook, detecta movimientos bancarios, guarda en Supabase

const { google } = require('googleapis');
const supabase = require('../lib/supabase');
const { parsearEmail, BANCOS } = require('../lib/email-parser');

// ─── Gmail ────────────────────────────────────────────────
async function syncGmail(emailAccount) {
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI
    );

    oauth2Client.setCredentials({
      access_token: emailAccount.access_token,
      refresh_token: emailAccount.refresh_token,
    });

    // Auto-refresh token si expiró
    const { credentials } = await oauth2Client.refreshAccessToken();
    if (credentials.access_token !== emailAccount.access_token) {
      await supabase.from('email_accounts').update({
        access_token: credentials.access_token,
        token_expiry: new Date(credentials.expiry_date).toISOString()
      }).eq('id', emailAccount.id);
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Buscar correos de bancos colombianos (últimas 24h)
    const bancosQuery = Object.values(BANCOS)
      .flatMap(b => b.remitentes)
      .map(r => `from:${r}`)
      .join(' OR ');

    const after = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const query = `(${bancosQuery}) after:${after}`;

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 50
    });

    const messages = listRes.data.messages || [];
    const results = [];

    for (const msg of messages) {
      // Verificar si ya procesamos este correo
      const { data: existing } = await supabase
        .from('email_logs')
        .select('id')
        .eq('email_message_id', msg.id)
        .single();

      if (existing) continue; // Ya procesado

      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full'
      });

      const headers = full.data.payload?.headers || [];
      const from = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '';

      // Extraer body
      let body = '';
      const parts = full.data.payload?.parts || [full.data.payload];
      for (const part of parts) {
        if (part?.mimeType === 'text/plain' && part.body?.data) {
          body += Buffer.from(part.body.data, 'base64').toString('utf8');
        }
      }

      const parsed = parsearEmail(from, subject, body, msg.id);

      // Registrar en log (procesado o no)
      await supabase.from('email_logs').insert({
        email_message_id: msg.id,
        email_account_id: emailAccount.id,
        banco: parsed?.banco || null,
        procesado: !!parsed,
        raw_subject: subject,
        raw_body: body.substring(0, 500)
      });

      if (parsed) {
        // Guardar movimiento
        const { data: movement } = await supabase.from('movements').insert({
          tipo: parsed.tipo,
          descripcion: parsed.descripcion,
          monto: parsed.monto,
          fecha: parsed.fecha,
          categoria: categoriaDesde(parsed.descripcion),
          nota: `Auto-detectado de ${parsed.bancoNombre}`,
          source: 'email',
          email_id: msg.id,
          confirmado: true
        }).select().single();

        // Actualizar log con movement_id
        if (movement) {
          await supabase.from('email_logs')
            .update({ movement_id: movement.id, procesado: true })
            .eq('email_message_id', msg.id);
        }

        // Crear alerta WhatsApp
        await crearAlertaWhatsApp(parsed, movement);

        results.push(parsed);
      }
    }

    // Actualizar último sync
    await supabase.from('email_accounts')
      .update({ ultimo_sync: new Date().toISOString() })
      .eq('id', emailAccount.id);

    return results;
  } catch (error) {
    console.error(`Error Gmail sync ${emailAccount.email}:`, error.message);
    return [];
  }
}

// ─── Outlook ──────────────────────────────────────────────
async function syncOutlook(emailAccount) {
  try {
    // Refresh token de Outlook
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.OUTLOOK_CLIENT_ID,
        client_secret: process.env.OUTLOOK_CLIENT_SECRET,
        refresh_token: emailAccount.refresh_token,
        grant_type: 'refresh_token',
        scope: 'Mail.Read offline_access'
      })
    });
    const tokens = await tokenRes.json();
    const accessToken = tokens.access_token;

    if (!accessToken) return [];

    // Actualizar token
    await supabase.from('email_accounts').update({
      access_token: accessToken,
      token_expiry: new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    }).eq('id', emailAccount.id);

    // Buscar correos de bancos (últimas 24h)
    const desde = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const bancosFilter = Object.values(require('../lib/email-parser').BANCOS)
      .flatMap(b => b.remitentes)
      .map(r => `from eq '${r}'`)
      .join(' or ');

    const msRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages?$filter=receivedDateTime ge ${desde}&$top=50&$select=id,subject,from,body`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const msData = await msRes.json();
    const messages = msData.value || [];
    const results = [];

    for (const msg of messages) {
      const { data: existing } = await supabase
        .from('email_logs')
        .select('id')
        .eq('email_message_id', msg.id)
        .single();

      if (existing) continue;

      const from = msg.from?.emailAddress?.address || '';
      const subject = msg.subject || '';
      const body = msg.body?.content?.replace(/<[^>]*>/g, ' ') || '';

      const parsed = parsearEmail(from, subject, body, msg.id);

      await supabase.from('email_logs').insert({
        email_message_id: msg.id,
        email_account_id: emailAccount.id,
        banco: parsed?.banco || null,
        procesado: !!parsed,
        raw_subject: subject,
        raw_body: body.substring(0, 500)
      });

      if (parsed) {
        const { data: movement } = await supabase.from('movements').insert({
          tipo: parsed.tipo,
          descripcion: parsed.descripcion,
          monto: parsed.monto,
          fecha: parsed.fecha,
          categoria: categoriaDesde(parsed.descripcion),
          nota: `Auto-detectado de ${parsed.bancoNombre}`,
          source: 'email',
          email_id: msg.id,
          confirmado: true
        }).select().single();

        if (movement) {
          await supabase.from('email_logs')
            .update({ movement_id: movement.id, procesado: true })
            .eq('email_message_id', msg.id);
        }

        await crearAlertaWhatsApp(parsed, movement);
        results.push(parsed);
      }
    }

    await supabase.from('email_accounts')
      .update({ ultimo_sync: new Date().toISOString() })
      .eq('id', emailAccount.id);

    return results;
  } catch (error) {
    console.error(`Error Outlook sync ${emailAccount.email}:`, error.message);
    return [];
  }
}

// ─── Helpers ──────────────────────────────────────────────
function categoriaDesde(descripcion) {
  const d = (descripcion || '').toLowerCase();
  if (/rappi|domicilio|restaurante|comida|burger|pizza|mcd|kfc/.test(d)) return 'alimentacion';
  if (/uber|didi|taxi|bus|metro|gasolina|parqueadero/.test(d)) return 'transporte';
  if (/netflix|spotify|disney|prime|youtube/.test(d)) return 'entretenimiento';
  if (/farmacia|drogueria|medico|clinica|salud/.test(d)) return 'salud';
  if (/arriendo|agua|luz|gas|internet|celular/.test(d)) return 'servicios';
  if (/supermercado|exito|olimpica|jumbo|d1|ara/.test(d)) return 'alimentacion';
  return 'otro';
}

async function crearAlertaWhatsApp(parsed, movement) {
  try {
    const { data: cfgRow } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'notificaciones')
      .single();

    const cfg = cfgRow?.value || {};
    if (!cfg.whatsapp_enabled || !cfg.whatsapp_numero) return;

    const emoji = parsed.tipo === 'ingreso' ? '💰' : '💳';
    const signo = parsed.tipo === 'ingreso' ? '+' : '-';
    const monto = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(parsed.monto);

    const mensaje = `${emoji} *Kontrol detectó un movimiento*\n\n${signo}${monto} — ${parsed.descripcion}\n🏦 ${parsed.bancoNombre}\n📅 ${parsed.fecha}\n\n_Registrado automáticamente en tu app_`;

    await supabase.from('whatsapp_alerts').insert({
      tipo: 'movimiento_banco',
      mensaje,
      telefono: cfg.whatsapp_numero,
      enviado: false
    });
  } catch (e) {
    console.error('Error creando alerta WhatsApp:', e.message);
  }
}

// ─── Handler principal ─────────────────────────────────────
module.exports = async function handler(req, res) {
  // Verificar que es llamada autorizada (cron de Vercel o manual)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && req.method !== 'GET') {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    // Obtener todas las cuentas de correo activas
    const { data: emailAccounts, error } = await supabase
      .from('email_accounts')
      .select('*')
      .eq('activo', true);

    if (error || !emailAccounts?.length) {
      return res.json({ ok: true, message: 'No hay correos configurados', movimientos: 0 });
    }

    let totalMovimientos = 0;

    for (const account of emailAccounts) {
      let resultados = [];
      if (account.tipo === 'gmail') {
        resultados = await syncGmail(account);
      } else if (account.tipo === 'outlook') {
        resultados = await syncOutlook(account);
      }
      totalMovimientos += resultados.length;
    }

    // Verificar agenda: ¿hay eventos para hoy sin notificar?
    await verificarAgenda();

    return res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      cuentas_revisadas: emailAccounts.length,
      movimientos_detectados: totalMovimientos
    });

  } catch (error) {
    console.error('Error en sync-emails:', error);
    return res.status(500).json({ error: error.message });
  }
};

async function verificarAgenda() {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const { data: eventos } = await supabase
      .from('events')
      .select('*')
      .eq('fecha', hoy)
      .eq('notificado', false);

    for (const evento of (eventos || [])) {
      const { data: cfgRow } = await supabase
        .from('config').select('value').eq('key', 'notificaciones').single();
      const cfg = cfgRow?.value || {};

      if (cfg.whatsapp_enabled && cfg.whatsapp_numero) {
        await supabase.from('whatsapp_alerts').insert({
          tipo: 'agenda',
          mensaje: `📅 *Recordatorio Kontrol*\n\nHoy tienes: *${evento.titulo}*${evento.hora ? ` a las ${evento.hora}` : ''}\n${evento.nota || ''}`,
          telefono: cfg.whatsapp_numero,
          enviado: false
        });
      }

      await supabase.from('events')
        .update({ notificado: true })
        .eq('id', evento.id);
    }
  } catch (e) {
    console.error('Error verificando agenda:', e.message);
  }
}
