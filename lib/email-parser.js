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

function parsearTipo(subject, body) {
  const texto = (subject + ' ' + body).toLowerCase();
  const palabrasGasto = ['compra','pago','retiro','transferencia enviada','débito','debitado','cobro','cargo'];
  const palabrasIngreso = ['consignación','consignacion','ingreso','transferencia recibida','recibiste','depósito','deposito','crédito'];

  for (const p of palabrasIngreso) if (texto.includes(p)) return 'ingreso';
  for (const p of palabrasGasto) if (texto.includes(p)) return 'gasto';
  return 'gasto';
}

function parsearDescripcion(subject, body, banco) {
  const texto = subject + ' ' + body;

  // Bancolombia: "Compra aprobada en NOMBRE_COMERCIO"
  let m = texto.match(/(?:compra|pago)\s+(?:aprobad[ao]\s+)?(?:en\s+)?([A-Z][A-Z\s\d*]{2,30})/i);
  if (m) return m[1].trim();

  // Nequi: "Te enviaron $X de NOMBRE"
  m = texto.match(/(?:de|desde)\s+([A-Za-záéíóúÁÉÍÓÚñ\s]{3,30})\s+(?:a través|via|por nequi)/i);
  if (m) return m[1].trim();

  // Comercio genérico
  m = texto.match(/comercio[:\s]+([A-Za-záéíóú\s\d*]{3,30})/i);
  if (m) return m[1].trim();

  // Usar asunto del correo como descripción
  const subjectLimpio = subject.replace(/bancolombia|nequi|davivienda|daviplata/gi, '').trim();
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
