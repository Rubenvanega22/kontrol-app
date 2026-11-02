// /lib/fechas-habladas.js — "hoy", "mañana", "pasado mañana" y los días de la semana,
// calculados con la fecha de Colombia. El modelo los calculó mal ("mañana" el lunes 2
// quedó en el miércoles 4), así que lo que aquí se entiende manda sobre lo que él escriba.
//
// Las fechas con número ("el 15", "15 de noviembre") no se calculan aquí: las lee el modelo.

const { colombiaDateString } = require('./datetime');
const { normalizar } = require('./horas-habladas');

const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const UN_DIA = 24 * 3600 * 1000;
const MESES = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre';

function sinAcentos(texto) {
  return String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function sumarDias(fecha, dias) {
  return colombiaDateString(new Date(new Date(`${fecha}T12:00:00-05:00`).getTime() + dias * UN_DIA));
}

function diaDeSemana(fecha) {
  return new Date(`${fecha}T12:00:00-05:00`).getUTCDay();
}

// "avísame el día anterior a las 6 pm" habla del aviso, no del evento.
function sinPedidoDeAviso(texto) {
  return sinAcentos(texto)
    .replace(/\b(el\s+)?dia\s+(anterior|antes)(\s+a\s+las?\s+\S+(\s+(am|pm))?)?/g, ' ')
    .replace(/\b(la\s+)?noche\s+(anterior|antes)(\s+a\s+las?\s+\S+(\s+(am|pm))?)?/g, ' ')
    .replace(/\b\S+\s+dias?\s+antes\b/g, ' ');
}

// Devuelve [{ dicho, fecha }] sin repetir fecha. Vacío si no hay nada que calcular, si
// habla del pasado o si trae una fecha con número.
function fechasDelTexto(texto, hoy = colombiaDateString()) {
  let t = normalizar(sinPedidoDeAviso(texto));
  if (new RegExp(`\\b\\d{1,2}\\s+de\\s+(${MESES})\\b|\\b(${MESES})\\s+\\d{1,2}\\b|\\b\\d{1,2}/\\d{1,2}\\b|\\bel\\s+\\d{1,2}\\b(?!\\s*(:|am|pm))`).test(t)) return [];

  const halladas = [];
  const agregar = (dicho, fecha) => {
    if (!halladas.some(h => h.fecha === fecha)) halladas.push({ dicho, fecha });
  };

  t = t.replace(/\bpasado\s+manana\b/g, m => { agregar(m, sumarDias(hoy, 2)); return ' '; });
  t = t.replace(/\besta\s+(manana|tarde|noche)\b/g, m => { agregar(m, hoy); return ' '; });
  // "a las 7 de la mañana" es una hora, no un día. "mañana por la mañana" deja el primero.
  t = t.replace(/\b(de|por|en|a)\s+la\s+(manana|tarde|noche)\b/g, ' ');
  if (/\bhoy\b/.test(t)) agregar('hoy', hoy);
  if (/\bmanana\b/.test(t)) agregar('mañana', sumarDias(hoy, 1));

  const enDias = t.match(/\b(?:en|dentro\s+de)\s+(\d{1,2}|un)\s+dias?\b/);
  if (enDias) agregar(enDias[0], sumarDias(hoy, enDias[1] === 'un' ? 1 : Number(enDias[1])));

  const hoyDia = diaDeSemana(hoy);
  const semanal = new RegExp(`\\b(los\\s+)?(${DIAS.join('|')})\\b(\\s+pasado\\b|\\s+\\d{1,2}\\b)?(\\s+de\\s+la\\s+(?:proxima|otra)\\s+semana|\\s+de\\s+la\\s+semana\\s+que\\s+viene)?`, 'g');
  for (const m of t.matchAll(semanal)) {
    if (m[1] || (m[3] && /pasado/.test(m[3]))) continue; // "los lunes", "el lunes pasado"
    if (m[3]) return []; // "el viernes 13" trae número: lo lee el modelo
    const dia = DIAS.indexOf(m[2]);
    // Nunca hoy: "el lunes" dicho un lunes es el de la otra semana.
    const dias = m[4]
      ? (((1 - hoyDia + 7) % 7) || 7) + ((dia - 1 + 7) % 7)
      : ((dia - hoyDia + 7) % 7) || 7;
    agregar(m[0].trim(), sumarDias(hoy, dias));
  }
  return halladas;
}

// La fecha, solo si el texto dice exactamente una.
function fechaUnicaDelTexto(texto, hoy = colombiaDateString()) {
  const fechas = fechasDelTexto(texto, hoy);
  return fechas.length === 1 ? fechas[0].fecha : null;
}

module.exports = { fechasDelTexto, fechaUnicaDelTexto, sinPedidoDeAviso, sumarDias };
