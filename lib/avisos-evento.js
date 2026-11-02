// /lib/avisos-evento.js — cuándo salen los avisos de un evento de Agenda.
//
// Con aviso elegido (aviso_en): un solo aviso, en ese momento.
// Sin elegir, "como siempre":
//   • Desde las 8 am: resumen de las 8 am, 1 hora antes y 15 minutos antes.
//   • Antes de las 8 am el resumen llegaría tarde: el día anterior a las 8 pm y 1 hora antes.

const HORA_CORTE = '08:00';
const HORA_NOCHE_ANTERIOR = '20:00';
const MIN = 60 * 1000;
const DIA = 24 * 60 * MIN;
// Si el cron se cae, el aviso aún sale dentro de este margen.
const MARGEN_ATRASO_MS = 2 * 60 * MIN;
// Un aviso a la hora misma del evento también tolera unos minutos de atraso.
const MARGEN_HORA_EXACTA_MS = 15 * MIN;

// Postgres TIME llega como "HH:MM:SS"; el formulario y la IA lo mandan "HH:MM".
function hhmm(hora) {
  return hora ? String(hora).slice(0, 5) : null;
}

function esTemprano(e) {
  const h = hhmm(e.hora);
  return !!h && h < HORA_CORTE;
}

function aFecha(fecha, hora) {
  const t = new Date(`${fecha}T${hhmm(hora)}:00-05:00`);
  return isNaN(t.getTime()) ? null : t;
}

function eventoADate(e) {
  return e.hora ? aFecha(e.fecha, e.hora) : null;
}

function diaAnterior(fecha) {
  const t = new Date(`${fecha}T12:00:00-05:00`).getTime() - DIA;
  return new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

// { fecha: "2026-11-03", hora: "20:00" } en hora Colombia.
function fechaHoraColombia(date) {
  const [fecha, hora] = date.toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).split(' ');
  return { fecha, hora: hora.slice(0, 5) };
}

// Convierte lo que eligió el usuario en el momento del aviso:
//   "siempre" o vacío     → sin aviso propio (en: null)
//   "antes:120"           → 120 minutos antes del evento
//   "dia_anterior"        → el día anterior a las 8 pm
//   "dia_anterior:18:00"  → el día anterior a esa hora
//   "hora:07:00", "07:00" → la última vez que ocurre esa hora antes del evento: para un
//                           evento a las 5 am, 4:30 es esa madrugada y 21:00 la noche anterior
// Devuelve { ok, en }; ok=false si no se entiende.
function resolverAviso(eleccion, fecha, hora) {
  const texto = String(eleccion || '').trim().toLowerCase();
  if (!texto || texto === 'siempre') return { ok: true, en: null };
  const evento = hora ? aFecha(fecha, hora) : null;
  if (!evento) return { ok: false };

  const antes = texto.match(/^antes:(\d{1,5})$/);
  if (antes && Number(antes[1]) > 0) return { ok: true, en: new Date(evento.getTime() - Number(antes[1]) * MIN) };

  const anterior = texto.match(/^dia_anterior(?::(\d{1,2}:\d{2}))?$/);
  if (anterior) {
    const a = normalizarHora(anterior[1] || HORA_NOCHE_ANTERIOR);
    return a ? { ok: true, en: aFecha(diaAnterior(fecha), a) } : { ok: false };
  }

  const aLaHora = texto.match(/^(?:hora:)?(\d{1,2}:\d{2})$/);
  if (aLaHora) {
    const a = normalizarHora(aLaHora[1]);
    if (!a) return { ok: false };
    return { ok: true, en: aFecha(a <= hhmm(hora) ? fecha : diaAnterior(fecha), a) };
  }
  return { ok: false };
}

// "5:30" → "05:30"; lo que no sea una hora válida → null.
function normalizarHora(texto) {
  const m = String(texto || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function avisoElegido(e) {
  if (!e.aviso_en) return null;
  const t = new Date(e.aviso_en);
  return isNaN(t.getTime()) ? null : t;
}

// El aviso propio del evento; null si solo lleva los normales de las 8 am en adelante.
function momentoAviso(e) {
  if (!eventoADate(e)) return null;
  return avisoElegido(e) || (esTemprano(e) ? aFecha(diaAnterior(e.fecha), HORA_NOCHE_ANTERIOR) : null);
}

function debeSalirAviso(e, ahoraMs = Date.now()) {
  if (e.notificado_aviso) return false;
  const evento = eventoADate(e);
  const momento = momentoAviso(e);
  if (!evento || !momento) return false;
  const m = momento.getTime();
  if (ahoraMs < m) return false;
  // Creado después de las 8 pm de la víspera: ese aviso ya no aplica y no sale tarde.
  if (!e.aviso_en && e.created_at && new Date(e.created_at).getTime() > m) return false;
  const fin = Math.min(m + MARGEN_ATRASO_MS, Math.max(evento.getTime(), m + MARGEN_HORA_EXACTA_MS));
  return ahoraMs <= fin;
}

function debeSalirUnaHoraAntes(e, ahoraMs = Date.now()) {
  if (!esTemprano(e) || e.aviso_en || e.notificado_1h) return false;
  const evento = eventoADate(e);
  if (!evento) return false;
  const faltan = evento.getTime() - ahoraMs;
  return faltan > 0 && faltan <= 60 * MIN;
}

// El resumen de las 8 am: un evento temprano ya pasó y uno con aviso elegido sale solo a esa hora.
function entraEnResumen(e) {
  return !esTemprano(e) && !e.aviso_en;
}

// Eventos desde las 8 am. Cada aviso sale en cuanto llega su minuto; si el evento se
// creó con menos margen, sale de una vez y el mensaje dice cuánto falta de verdad.
function minutosFaltantes(e, ahoraMs = Date.now()) {
  const evento = eventoADate(e);
  return evento ? (evento.getTime() - ahoraMs) / MIN : null;
}

function tocaUnaHoraNormal(e, ahoraMs = Date.now()) {
  if (!entraEnResumen(e)) return false;
  const faltan = minutosFaltantes(e, ahoraMs);
  return faltan !== null && faltan > 15 && faltan <= 60;
}

function tocaQuinceNormal(e, ahoraMs = Date.now()) {
  if (!entraEnResumen(e)) return false;
  const faltan = minutosFaltantes(e, ahoraMs);
  // El borde -15 tolera una caída corta del cron.
  return faltan !== null && faltan >= -15 && faltan <= 15;
}

// Encabezado del aviso según lo que falta: "En 1 hora", "En 15 min", "Ahora".
function textoFaltan(minutos) {
  const m = Math.round(minutos);
  if (m <= 0) return 'Ahora';
  return m >= 58 ? 'En 1 hora' : `En ${m} min`;
}

// "05:00:00" → "5:00 am"
function horaCorta(hora) {
  const h = hhmm(hora);
  if (!h) return '';
  const [hh, mm] = h.split(':').map(Number);
  return `${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`;
}

module.exports = {
  hhmm, esTemprano, eventoADate, diaAnterior, fechaHoraColombia, resolverAviso, normalizarHora,
  momentoAviso, debeSalirAviso, debeSalirUnaHoraAntes, entraEnResumen, horaCorta,
  minutosFaltantes, tocaUnaHoraNormal, tocaQuinceNormal, textoFaltan
};
