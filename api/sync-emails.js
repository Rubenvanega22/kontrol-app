// /api/sync-emails.js
// Se ejecuta cada 5 minutos automáticamente (Vercel Cron)
// Lee Gmail + Outlook, detecta movimientos bancarios, guarda en Supabase

const { google } = require('googleapis');
const supabase = require('../lib/supabase');
const { parsearEmail, BANCOS } = require('../lib/email-parser');

// ─── Helpers de saldo (mismo patrón que api/ai-chat.js: leer fresh antes de actualizar) ───

// Busca la cuenta del usuario cuyo nombre contiene el nombre del banco (case-insensitive).
// Si hay varias devuelve la primera y loguea warning.
async function findAccountForBanco(userId, bancoNombre) {
  if (!userId || !bancoNombre) return null;
  const { data, error } = await supabase
    .from('accounts')
    .select('id, nombre, saldo')
    .eq('user_id', userId)
    .ilike('nombre', `%${bancoNombre}%`);
  if (error) {
    console.error('[sync] findAccountForBanco error:', error.message);
    return null;
  }
  if (!data || data.length === 0) return null;
  if (data.length > 1) {
    console.warn(`[sync] múltiples cuentas matchean "${bancoNombre}" para user ${userId}: ${data.map(a=>a.nombre).join(', ')}. Usando la primera.`);
  }
  return data[0];
}

// Lee saldo fresh, suma delta, hace UPDATE, loguea antes/delta/después.
// Devuelve {antes, delta, despues, nombre} o null en error.
async function ajustarSaldoCuenta(userId, accountId, delta, opLabel) {
  const { data: row, error: ferr } = await supabase
    .from('accounts')
    .select('saldo, nombre')
    .eq('id', accountId)
    .eq('user_id', userId)
    .maybeSingle();
  if (ferr || !row) {
    console.error(`[sync] ${opLabel}: no se pudo leer cuenta ${accountId}:`, ferr?.message || 'no encontrada');
    return null;
  }
  const antes = parseFloat(row.saldo || 0);
  const despues = antes + delta;
  const { error: uerr } = await supabase
    .from('accounts')
    .update({ saldo: despues })
    .eq('id', accountId)
    .eq('user_id', userId);
  if (uerr) {
    console.error(`[sync] ${opLabel}: update saldo falló:`, uerr.message);
    return null;
  }
  console.log(`[sync] ${opLabel}: cuenta "${row.nombre}" saldo antes=${antes} delta=${delta >= 0 ? '+' : ''}${delta} después=${despues}`);
  return { antes, delta, despues, nombre: row.nombre };
}

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

    const after = Math.floor((Date.now() - 30*24*60*60*1000) / 1000);
    const query = `(${bancosQuery}) after:${after}`;

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 50
    });

    console.log('[sync] Gmail messages found:', listRes.data.messages?.length || 0);
    console.log('[sync] Query used:', query);
    console.log('[sync] Full query:', JSON.stringify(query));

    // Diagnóstico: probar query plana sin from: para ver si hay correos de Bancolombia
    const testQuery = 'bancolombia after:' + after;
    const testRes = await gmail.users.messages.list({ userId: 'me', q: testQuery, maxResults: 5 });
    console.log('[sync] Test query results:', testRes.data.messages?.length || 0);

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
        // Buscar cuenta del usuario que matchee el banco detectado.
        const cuenta = await findAccountForBanco(emailAccount.user_id, parsed.bancoNombre);

        // Aplicar el delta sobre el saldo de la cuenta antes de insertar el movimiento.
        // 'gasto' y 'retiro' restan; 'ingreso' suma.
        let ajuste = null;
        if (cuenta) {
          const esEgreso = parsed.tipo === 'gasto' || parsed.tipo === 'retiro';
          const delta = esEgreso ? -parsed.monto : +parsed.monto;
          ajuste = await ajustarSaldoCuenta(
            emailAccount.user_id,
            cuenta.id,
            delta,
            `${parsed.bancoNombre} ${parsed.tipo}`
          );
        } else {
          console.warn(`[sync] ${parsed.bancoNombre}: usuario ${emailAccount.user_id} no tiene cuenta con nombre que matchee "${parsed.bancoNombre}". Movimiento se guarda sin ajustar saldo.`);
        }

        // Guardar movimiento — confirmado=true porque el banco ya confirmó la operación.
        const { data: movement } = await supabase.from('movements').insert({
          tipo: parsed.tipo,
          descripcion: parsed.descripcion,
          monto: parsed.monto,
          fecha: parsed.fecha,
          categoria: categoriaDesde(parsed.descripcion),
          nota: `Auto-detectado de ${parsed.bancoNombre}`,
          source: 'email',
          email_id: msg.id,
          account_id: cuenta ? cuenta.id : null,
          confirmado: !!cuenta,  // solo confirmamos si el saldo se ajustó
          user_id: emailAccount.user_id || null
        }).select().single();

        // Actualizar log con movement_id
        if (movement) {
          await supabase.from('email_logs')
            .update({ movement_id: movement.id, procesado: true })
            .eq('email_message_id', msg.id);
        }

        // Crear alerta WhatsApp
        await crearAlertaWhatsApp(parsed, movement);

        results.push({ ...parsed, ajuste, account_id: cuenta?.id || null });
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
        // Misma lógica que syncGmail: encontrar la cuenta del banco y ajustar saldo.
        const cuenta = await findAccountForBanco(emailAccount.user_id, parsed.bancoNombre);
        let ajuste = null;
        if (cuenta) {
          const esEgreso = parsed.tipo === 'gasto' || parsed.tipo === 'retiro';
          const delta = esEgreso ? -parsed.monto : +parsed.monto;
          ajuste = await ajustarSaldoCuenta(
            emailAccount.user_id,
            cuenta.id,
            delta,
            `${parsed.bancoNombre} ${parsed.tipo}`
          );
        } else {
          console.warn(`[sync] ${parsed.bancoNombre}: usuario ${emailAccount.user_id} no tiene cuenta con nombre que matchee "${parsed.bancoNombre}".`);
        }

        const { data: movement } = await supabase.from('movements').insert({
          tipo: parsed.tipo,
          descripcion: parsed.descripcion,
          monto: parsed.monto,
          fecha: parsed.fecha,
          categoria: categoriaDesde(parsed.descripcion),
          nota: `Auto-detectado de ${parsed.bancoNombre}`,
          source: 'email',
          email_id: msg.id,
          account_id: cuenta ? cuenta.id : null,
          confirmado: !!cuenta,
          user_id: emailAccount.user_id || null
        }).select().single();

        if (movement) {
          await supabase.from('email_logs')
            .update({ movement_id: movement.id, procesado: true })
            .eq('email_message_id', msg.id);
        }

        await crearAlertaWhatsApp(parsed, movement);
        results.push({ ...parsed, ajuste, account_id: cuenta?.id || null });
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
// 3 modos de auth:
//   1. GET (Vercel cron) — procesa todas las cuentas activas
//   2. POST con CRON_SECRET — manual del cron, mismo comportamiento
//   3. POST con JWT de Supabase — solo procesa cuentas del usuario autenticado
//      y devuelve la lista de detecciones para que el frontend muestre confirmación.
module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  let userId = null;
  let isCron = false;

  if (authHeader === `Bearer ${process.env.CRON_SECRET}`) {
    isCron = true;
  } else if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) return res.status(401).json({ error: 'Token inválido' });
      userId = data.user.id;
    } catch (e) {
      return res.status(401).json({ error: 'Token inválido: ' + e.message });
    }
  } else if (req.method === 'GET') {
    // Vercel cron GET sin auth header
    isCron = true;
  } else {
    return res.status(401).json({ error: 'Sin autenticación' });
  }

  try {
    let query = supabase.from('email_accounts').select('*').eq('activo', true);
    if (userId) query = query.eq('user_id', userId);
    const { data: emailAccounts, error } = await query;

    if (error || !emailAccounts?.length) {
      return res.json({
        ok: true,
        message: 'No hay correos configurados',
        cuentas_revisadas: 0,
        movimientos_detectados: 0,
        detecciones: []
      });
    }

    let detecciones = [];

    for (const account of emailAccounts) {
      let resultados = [];
      if (account.tipo === 'gmail') {
        resultados = await syncGmail(account);
      } else if (account.tipo === 'outlook') {
        resultados = await syncOutlook(account);
      }
      detecciones = detecciones.concat(resultados);
    }

    // (Recordatorios de agenda movidos a /api/reminders-cron)

    return res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      cuentas_revisadas: emailAccounts.length,
      movimientos_detectados: detecciones.length,
      detecciones
    });

  } catch (error) {
    console.error('Error en sync-emails:', error);
    return res.status(500).json({ error: error.message });
  }
};

// verificarAgenda removida — ahora vive en /api/reminders-cron con teléfonos por usuario
