// ═══════════════════════════════════════
// Parser de correos bancarios colombianos
// Bancolombia, Nequi, Davivienda, Daviplata
// ═══════════════════════════════════════

const BANCOS = {
  bancolombia: {
    remitentes: ['notificaciones@bancolombia.com.co','alertas@bancolombia.com.co','no-reply@bancolombia.com.co'],
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
  // Patrones colombianos: $1.250.000, 1250000, $1,250,000.00
  const patrones = [
    /\$\s*([\d]{1,3}(?:[.,][\d]{3})*(?:[.,]\d{2})?)/,
    /(?:valor|monto|pago|compra|retiro|consignacion)[:\s]+\$?\s*([\d]{1,3}(?:[.,][\d]{3})*)/i,
    /([\d]{1,3}(?:\.\d{3})+)/,
  ];
  for (const patron of patrones) {
    const m = texto.match(patron);
    if (m) {
      const raw = m[1].replace(/\./g, '').replace(/,/g, '');
      const n = parseFloat(raw);
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
