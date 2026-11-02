// /lib/avisos-evento.js — cuándo salen los avisos de un evento de Agenda.
//
// Desde las 8 am: resumen de las 8 am, 1 hora antes y 15 minutos antes.
// Antes de las 8 am el resumen llegaría tarde, así que:
//   • Con aviso_hora: un solo aviso, a esa hora.
//   • Sin aviso_hora: uno el día anterior a las 8 pm y otro 1 hora antes.

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

// Una hora elegida cae en la última vez que ocurre antes del evento: para un evento a
// las 5 am, "4:30" es esa misma madrugada y "21:00" es la noche anterior.
function momentoAviso(e) {
  if (!eventoADate(e)) return null;
  const elegida = hhmm(e.aviso_hora);
  if (!elegida) return aFecha(diaAnterior(e.fecha), HORA_NOCHE_ANTERIOR);
  const mismoDia = elegida <= hhmm(e.hora);
  return aFecha(mismoDia ? e.fecha : diaAnterior(e.fecha), elegida);
}

function debeSalirAviso(e, ahoraMs = Date.now()) {
  if (!esTemprano(e) || e.notificado_aviso) return false;
  const evento = eventoADate(e);
  const momento = momentoAviso(e);
  if (!evento || !momento) return false;
  const m = momento.getTime();
  if (ahoraMs < m) return false;
  // Creado después de las 8 pm de la víspera: ese aviso ya no aplica y no sale tarde.
  if (!e.aviso_hora && e.created_at && new Date(e.created_at).getTime() > m) return false;
  const fin = Math.min(m + MARGEN_ATRASO_MS, Math.max(evento.getTime(), m + MARGEN_HORA_EXACTA_MS));
  return ahoraMs <= fin;
}

function debeSalirUnaHoraAntes(e, ahoraMs = Date.now()) {
  if (!esTemprano(e) || e.aviso_hora || e.notificado_1h) return false;
  const evento = eventoADate(e);
  if (!evento) return false;
  const faltan = evento.getTime() - ahoraMs;
  return faltan > 0 && faltan <= 60 * MIN;
}

// "05:00:00" → "5:00 am"
function horaCorta(hora) {
  const h = hhmm(hora);
  if (!h) return '';
  const [hh, mm] = h.split(':').map(Number);
  return `${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`;
}

module.exports = {
  hhmm, esTemprano, eventoADate, diaAnterior, momentoAviso,
  debeSalirAviso, debeSalirUnaHoraAntes, horaCorta
};
