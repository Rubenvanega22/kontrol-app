// ═══════════════════════════════════════
// Parser de correos bancarios colombianos
// Bancolombia, Nequi, Davivienda, Daviplata
// ═══════════════════════════════════════

const BANCOS = {
  bancolombia: {
    // El remitente real verificado en producción es:
    //   alertasynotificaciones@an.notificacionesbancolombia.com
    // (dominio .com, NO .com.co como decía la lista anterior).
    // Mantenemos los .com.co como fallback por si Bancolombia los usa para otros canales.
    //
    // Los entries sin "@" actúan como catch-all de dominio: la query Gmail "from:<dominio>"
    // matchea cualquier remitente de ese dominio y subdominios. detectarBanco() usa
    // fromLower.includes(r) así que el substring también funciona si el correo llega
    // por otra ruta.
    remitentes: [
      'an.notificacionesbancolombia.com',
      'notificacionesbancolombia.com',
      'alertasynotificaciones@an.notificacionesbancolombia.com',
      'bancolombia.com.co',
      'alertasynotificaciones@bancolombia.com.co',
      'alertas@notificaciones.bancolombia.com.co',
      'no-responder@notificaciones.bancolombia.com.co',
      'notificaciones@bancolombia.com.co',
      'alertas@bancolombia.com.co',
      'no-reply@bancolombia.com.co'
    ],
    nombre: 'Bancolombia'
  },
  nequi: {
    remitentes: ['notificaciones@nequi.com','no-reply@nequi.com','alertas@nequi.com.co'],
    nombre: 'Nequi'
  },
  davivienda: {
    remitentes: ['alertas@davivienda.com','notificaciones@davivienda.com'],
    nombre: 'Davivienda'
  },
  daviplata: {
    remitentes: ['notificaciones@daviplata.com','alertas@daviplata.com'],
    nombre: 'Daviplata'
  },
  bbva: {
    remitentes: ['alertas@bbva.com.co','notificaciones@bbva.com.co'],
    nombre: 'BBVA'
  }
};

function detectarBanco(from, subject, body) {
  const fromLower = (from || '').toLowerCase();
  const allText = (subject + ' ' + body).toLowerCase();

  for (const [key, banco] of Object.entries(BANCOS)) {
    if (banco.remitentes.some(r => fromLower.includes(r))) return key;
    if (allText.includes(banco.nombre.toLowerCase())) return key;
  }
  return null;
}

function parsearMonto(texto) {
  // Formato colombiano de pesos:
  //   - Punto (.)  = separador de miles    → $1.500.000 = 1.500.000 pesos
  //   - Coma (,)   = separador decimal      → $1.500.000,00 = 1.500.000 con 0 cents
  //
  // Bug previo: el regex permitía cents (",00" o ".00") DENTRO del grupo capturado,
  // y luego .replace(/\./g, '').replace(/,/g, '') strippeaba todos los separadores
  // concatenando los cents al entero (ej: $150.000,00 se parseaba como 15.000.000 — 100x off).
  //
  // Fix: los cents quedan FUERA del grupo capturado. m[1] contiene solo la parte ENTERA
  // con separadores de miles, así que strippearlos da el valor correcto.
  const patrones = [
    // $1.500.000 o $1.500.000,00  (colombiano)
    /\$\s*(\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?(?!\d)/,
    // $1,500,000 o $1,500,000.00  (US fallback, separadores invertidos)
    /\$\s*(\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?(?!\d)/,
    // Con keyword previa: "Valor: $150.000", "Compra por 1.500.000"
    /(?:valor|monto|pago|compra|retiro|consignaci[oó]n|por)[:\s]+\$?\s*(\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?(?!\d)/i,
    // Sufijo "COP" o "pesos"
    /(\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?\s*(?:cop|pesos)\b/i,
    // Standalone con al menos UN separador de miles, no embebido en otro número
    /(?<!\d)(\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?(?!\d)/
  ];
  for (const patron of patrones) {
    const m = texto.match(patron);
    if (m) {
      // m[1] solo trae la parte ENTERA con separadores de miles (. o ,).
      // Strippeamos cualquier separador para quedarnos con dígitos puros.
      const enteroStr = m[1].replace(/[.,]/g, '');
      const n = parseInt(enteroStr, 10);
      if (n > 0 && n < 1000000000) return n;
    }
  }
  return null;
}

function parsearFecha(texto) {
  const hoy = new Date();
  const patrones = [
    /(\d{2})\/(\d{2})\/(\d{4})/,
    /(\d{4})-(\d{2})-(\d{2})/,
    /(\d{2})-(\d{2})-(\d{4})/,
  ];
  for (const p of patrones) {
    const m = texto.match(p);
    if (m) {
      try {
        let d;
        if (m[1].length === 4) d = new Date(`${m[1]}-${m[2]}-${m[3]}`);
        else if (m[3].length === 4) d = new Date(`${m[3]}-${m[2]}-${m[1]}`);
        if (d && !isNaN(d)) return d.toISOString().split('T')[0];
      } catch(e) {}
    }
  }
  return hoy.toISOString().split('T')[0];
}

// Categoría del movimiento. Prioridad: GASTO fuerte → INGRESO fuerte → INGRESO débil.
//
// Bug anterior: el ingreso se chequeaba primero, así que un correo con "Compra con
// tarjeta débito ... crédito sobre tu cuenta de crédito" caía en ingreso por la
// palabra "crédito" aunque era un débito. Resultado: el saldo subía cuando debía
// bajar.
//
// Strong = palabras que SOLO aparecen en un sentido (no son ambiguas).
// Weak = palabras que pueden aparecer en ambos lados (ej. "crédito" puede ser
//   tipo de tarjeta o un abono).
function parsearTipo(subject, body) {
  const texto = (subject + ' ' + body).toLowerCase();

  // 0. INGRESO específico — patrones inequívocos que deben ganar sobre
  //    cualquier palabra "gasto-fuerte" que aparezca en el resto del cuerpo.
  //    Why: Bancolombia "Recibiste un pago de Nómina de X" contiene "pago"
  //    (gastoFuerte) pero es claramente un ingreso — el orden anterior
  //    marcaba estos abonos de nómina como gasto.
  const ingresoEspecifico = [
    /recibiste\s+un(?:\s+nuevo)?\s+(?:pago|abono|dep[oó]sito)/,
    /recibiste\s+una\s+(?:transferencia|consignaci[oó]n)/,
    /(?:abono|pago|consignaci[oó]n)\s+de\s+n[oó]mina/,
    /te\s+(?:enviaron|abonaron|transfirieron|consignaron)/
  ];
  for (const re of ingresoEspecifico) if (re.test(texto)) return 'ingreso';

  const gastoFuerte = [
    'débito','debito','retiro','pago','compra','compraste','transferiste',
    'pagaste','descuento','cobro','suscripción','suscripcion','cargo',
    'transferencia enviada','transferencia realizada'
  ];
  const ingresoFuerte = [
    'abono','consignación','consignacion','transferencia recibida','recibiste',
    'te enviaron','depósito','deposito'
  ];
  const ingresoDebil = ['crédito','credito','ingreso'];

  // 1. Strong gasto gana — los bancos siempre lideran con la palabra de acción.
  for (const p of gastoFuerte) if (texto.includes(p)) return 'gasto';
  // 2. Strong ingreso.
  for (const p of ingresoFuerte) if (texto.includes(p)) return 'ingreso';
  // 3. Weak ingreso solo si no hubo señal de gasto arriba.
  for (const p of ingresoDebil) if (texto.includes(p)) return 'ingreso';
  // 4. Default: gasto (conservador — mejor subestimar el ingreso).
  return 'gasto';
}

// Limpia un fragmento capturado de descripción: quita prefijos comunes,
// limita la longitud y normaliza espacios.
function limpiarDesc(s) {
  return (s || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+(por|valor|con|que|hoy|ayer|el|del|desde|hacia|para)\s+.*$/i, '')
    .trim()
    .slice(0, 60);
}

function parsearDescripcion(subject, body, banco) {
  const texto = subject + ' ' + body;

  // ─── Bancolombia (formato actual "Alertas y Notificaciones") ───
  // El body real lleva el verbo en mayúscula al inicio de cada frase.
  // Anclar al verbo permite distinguir Compraste / Transferiste / pagaste / Recibiste.

  // Nómina: "Recibiste un pago de Nomina de COMPANY por $X"
  let m = texto.match(/Recibiste\s+un\s+pago\s+de\s+N[oó]mina\s+de\s+([A-Za-zÁÉÍÓÚÑáéíóúñ0-9.&*\-\s]{2,40}?)\s+por\s+\$/i);
  if (m) return ('Nómina ' + limpiarDesc(m[1])).slice(0, 60);

  // Recibo genérico: "Recibiste un pago de NAME por $X"
  m = texto.match(/Recibiste\s+un\s+pago\s+de\s+([A-Za-zÁÉÍÓÚÑáéíóúñ0-9.&*\-\s]{2,40}?)\s+por\s+\$/i);
  if (m) return ('Pago de ' + limpiarDesc(m[1])).slice(0, 60);

  // Transferencia recibida: "Recibiste una transferencia de NAME por $X"
  m = texto.match(/Recibiste\s+una?\s+transferencia\s+de\s+([A-Za-zÁÉÍÓÚÑáéíóúñ0-9.&*\-\s]{2,40}?)\s+por\s+\$/i);
  if (m) return ('Transferencia de ' + limpiarDesc(m[1])).slice(0, 60);

  // Compra T.Deb/T.Cred: "Compraste $X en MERCHANT con tu T.Deb *NNNN"
  m = texto.match(/Compraste\s+\$[\d.,]+\s+en\s+([A-Za-z0-9.&*\-\s]{2,40}?)\s+con\s+tu\s+T\.?\s*(?:Deb|Cred)/i);
  if (m) return ('Compra ' + limpiarDesc(m[1])).slice(0, 60);

  // Transferencia saliente: "Transferiste $X desde tu cuenta NNNN a la cuenta *YYYY"
  m = texto.match(/Transferiste\s+\$[\d.,]+\s+desde\s+tu\s+cuenta\s+\*?\d+\s+a\s+la\s+cuenta\s+\*?(\d+)/i);
  if (m) return 'Transferencia a *' + m[1];

  // Pago QR: "... pagaste $X por codigo QR ... a la llave NNNN"
  m = texto.match(/pagaste\s+\$[\d.,]+\s+por\s+c[oó]digo\s+QR\s+desde\s+tu\s+cuenta\s+\*?\d+\s+a\s+la\s+llave\s+(\d+)/i);
  if (m) return 'QR a ' + m[1];

  // ─── Patrones legacy (Nequi / Davivienda / Daviplata / BBVA) ───

  // "en establecimiento NOMBRE_COMERCIO"
  m = texto.match(/en\s+establecimiento\s+([A-Za-z0-9*&.\-\s]{3,40})/i);
  if (m) return limpiarDesc(m[1]);

  // "concepto NOMINA PELLAR SAS"
  m = texto.match(/concepto[:\s]+([A-Za-z0-9*&.\-\sáéíóúÁÉÍÓÚñÑ]{3,60})/i);
  if (m) return limpiarDesc(m[1]);

  // "Pago realizado por $X a NAME" / "Transferencia ... a NAME"
  m = texto.match(/(?:pago|transferencia|abono|env[íi]o)\s+[\s\S]{0,60}?\sa\s+([A-Z][A-Za-z0-9*&.\-\sáéíóúÁÉÍÓÚñÑ]{2,40})/i);
  if (m) return limpiarDesc(m[1]);

  // "Pago a CLARO" / "Transferencia a CC 123" (forma directa)
  m = texto.match(/(?:pago|transferencia|abono)\s+a\s+([A-Za-z0-9*&.\-\sáéíóúÁÉÍÓÚñÑ]{3,40})/i);
  if (m) return limpiarDesc(m[1]);

  // Compra/Pago genérico con MAYÚSCULA. Why: el patrón anterior usaba /i así
  // que [A-Z] también matcheaba minúsculas, lo que generaba descripciones
  // basura como "de Nomina de PELLAR SAS" en abonos. Sin /i sólo entra cuando
  // el verbo y el comercio están realmente en mayúsculas.
  m = texto.match(/(?:Compra|Pago)\s+(?:aprobad[ao]\s+)?(?:en\s+)?([A-Z][A-Z0-9*&.\-\s]{2,40})/);
  if (m) return limpiarDesc(m[1]);

  // Nequi: "Te enviaron $X de NOMBRE"
  m = texto.match(/(?:de|desde)\s+([A-Za-záéíóúÁÉÍÓÚñÑ\s]{3,30})\s+(?:a través|via|por nequi)/i);
  if (m) return limpiarDesc(m[1]);

  // "comercio: X"
  m = texto.match(/comercio[:\s]+([A-Za-záéíóúÁÉÍÓÚñÑ0-9*&.\-\s]{3,40})/i);
  if (m) return limpiarDesc(m[1]);

  // Fallback: subject sin nombre de banco
  const subjectLimpio = (subject || '').replace(/bancolombia|nequi|davivienda|daviplata|bbva/gi, '').replace(/\s+/g, ' ').trim();
  if (subjectLimpio.length > 3) return subjectLimpio.substring(0, 50);

  return `Movimiento ${banco}`;
}

function parsearEmail(from, subject, body, messageId) {
  const banco = detectarBanco(from, subject, body);
  if (!banco) return null;

  const monto = parsearMonto(subject + ' ' + body);
  if (!monto) return null;

  return {
    banco,
    bancoNombre: BANCOS[banco]?.nombre || banco,
    tipo: parsearTipo(subject, body),
    monto,
    descripcion: parsearDescripcion(subject, body, banco),
    fecha: parsearFecha(subject + ' ' + body),
    messageId,
    rawSubject: subject,
    confianza: monto > 0 ? 'alta' : 'baja'
  };
}

module.exports = { parsearEmail, detectarBanco, BANCOS };
