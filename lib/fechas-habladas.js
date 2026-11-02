// /lib/fechas-habladas.js — "hoy", "mañana", "pasado mañana", los días de la semana y las
// fechas con número ("el 15", "15 de noviembre", "el 15 del otro mes"), calculados con la
// fecha de Colombia. El modelo los calculó mal ("mañana" el lunes 2 quedó en el miércoles 4),
// así que lo que aquí se entiende manda sobre lo que él escriba.

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

function diasDelMes(anio, mes) {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

function armarFecha(anio, mes, dia) {
  if (mes < 1 || mes > 12 || dia < 1 || dia > diasDelMes(anio, mes)) return null;
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function partes(fecha) {
  return fecha.split('-').map(Number);
}

function mesSiguiente(anio, mes, cuantos = 1) {
  const total = anio * 12 + (mes - 1) + cuantos;
  return [Math.floor(total / 12), (total % 12) + 1];
}

// "El 15": este mes, y si ya pasó, el siguiente. Hoy cuenta. Un mes sin ese día se salta:
// "el 31" dicho en noviembre es el 31 de diciembre.
function proximoConDia(dia, hoy) {
  const [anio, mes] = partes(hoy);
  for (let i = 0; i <= 12; i++) {
    const [a, m] = mesSiguiente(anio, mes, i);
    const fecha = armarFecha(a, m, dia);
    if (fecha && fecha >= hoy) return fecha;
  }
  return null;
}

function nombreDia(fecha) {
  return ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][diaDeSemana(fecha)];
}

const SEMANA = DIAS.join('|');
const NUM_MES = MESES.split('|');
const CON_DIA = `(?:(${SEMANA})\\s+)?(?:el\\s+)?(?:dia\\s+)?`;
// Lo que sigue al número dice que no es una fecha: "el 3 de la tarde", "el 5 piso".
const NO_ES_DIA = '(?!\\s*(?::|am\\b|pm\\b|a\\.\\s?m|p\\.\\s?m|de la\\b|del dia\\b|piso\\b|personas\\b|horas?\\b|minutos?\\b))';

// Saca del texto las fechas con número y las anota.
function fechasConNumero(texto, hoy, agregar, anotarDuda) {
  let t = texto.replace(/\b(el|dia)\s+primero\b/g, 'el 1').replace(/\bprimero\s+de\b/g, '1 de');
  const [anioHoy, mesHoy] = partes(hoy);

  const anotar = (dicho, fecha, semana, sinFecha) => {
    if (!fecha) { anotarDuda(dicho, sinFecha); return; }
    if (semana && DIAS[diaDeSemana(fecha)] !== semana) {
      const [, , d] = partes(fecha);
      anotarDuda(dicho, `El ${d} es ${nombreDia(fecha)}, no ${semana}. ¿Para qué día?`);
      return;
    }
    agregar(dicho, fecha);
  };
  const conMes = (dia, mes, anioDicho) => {
    if (anioDicho) return armarFecha(anioDicho, mes, dia);
    const f = armarFecha(anioHoy, mes, dia);
    if (f && f >= hoy) return f;
    return armarFecha(anioHoy + 1, mes, dia);
  };
  const sinEseDia = dia => `Ese mes no tiene día ${dia}. ¿Para qué día?`;
  const anio4 = a => {
    if (!a) return null;
    return a.length === 2 ? 2000 + Number(a) : Number(a);
  };

  // "15/11", "15/11/2026"
  t = t.replace(new RegExp(`\\b${CON_DIA}(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b`, 'g'), (m, sem, d, me, a) => {
    anotar(m.trim(), conMes(Number(d), Number(me), anio4(a)), sem, sinEseDia(d));
    return ' ';
  });
  // "15 de noviembre", "el martes 15 de noviembre de 2027"
  t = t.replace(new RegExp(`\\b${CON_DIA}(\\d{1,2})\\s+(?:de\\s+)?(${MESES})(?:\\s+(?:de|del)\\s+(\\d{4}))?\\b`, 'g'), (m, sem, d, me, a) => {
    anotar(m.trim(), conMes(Number(d), NUM_MES.indexOf(me) + 1, anio4(a)), sem, sinEseDia(d));
    return ' ';
  });
  // "noviembre 15"
  t = t.replace(new RegExp(`\\b(${MESES})\\s+(\\d{1,2})\\b${NO_ES_DIA}`, 'g'), (m, me, d) => {
    anotar(m.trim(), conMes(Number(d), NUM_MES.indexOf(me) + 1), null, sinEseDia(d));
    return ' ';
  });
  // "el 15 del otro mes", "el 15 de este mes"
  t = t.replace(new RegExp(`\\b${CON_DIA}(\\d{1,2})\\s+del?\\s+(otro mes|proximo mes|siguiente mes|mes que viene|mes entrante|este mes|mes)\\b`, 'g'), (m, sem, d, cual) => {
    const [a, me] = /^(este mes|mes)$/.test(cual) ? [anioHoy, mesHoy] : mesSiguiente(anioHoy, mesHoy);
    anotar(m.trim(), armarFecha(a, me, Number(d)), sem, sinEseDia(d));
    return ' ';
  });
  // "el 15", "el día 15", "el viernes 13", "viernes el 13"
  t = t.replace(new RegExp(`\\b(?:el\\s+)?(${SEMANA})\\s+(?:el\\s+)?(?:dia\\s+)?(\\d{1,2})\\b${NO_ES_DIA}`, 'g'), (m, sem, d) => {
    anotar(m.trim(), proximoConDia(Number(d), hoy), sem, sinEseDia(d));
    return ' ';
  });
  t = t.replace(new RegExp(`\\bel\\s+(?:dia\\s+)?(\\d{1,2})\\b${NO_ES_DIA}`, 'g'), (m, d) => {
    anotar(m.trim(), proximoConDia(Number(d), hoy), null, sinEseDia(d));
    return ' ';
  });
  return t;
}

// Devuelve [{ dicho, fecha }] sin repetir fecha, y { dicho, duda } si lo dicho no puede ser
// ("31 de noviembre", "el martes 13" si el 13 es viernes). Vacío si no hay nada que calcular
// o si habla del pasado.
function fechasDelTexto(texto, hoy = colombiaDateString()) {
  const halladas = [];
  const agregar = (dicho, fecha) => {
    if (!halladas.some(h => h.fecha === fecha)) halladas.push({ dicho, fecha });
  };
  const anotarDuda = (dicho, duda) => halladas.push({ dicho, duda });
  let t = fechasConNumero(normalizar(sinPedidoDeAviso(texto)), hoy, agregar, anotarDuda);

  t = t.replace(/\bpasado\s+manana\b/g, m => { agregar(m, sumarDias(hoy, 2)); return ' '; });
  t = t.replace(/\besta\s+(manana|tarde|noche)\b/g, m => { agregar(m, hoy); return ' '; });
  // "a las 7 de la mañana" es una hora, no un día. "mañana por la mañana" deja el primero.
  t = t.replace(/\b(de|por|en|a)\s+la\s+(manana|tarde|noche)\b/g, ' ');
  if (/\bhoy\b/.test(t)) agregar('hoy', hoy);
  if (/\bmanana\b/.test(t)) agregar('mañana', sumarDias(hoy, 1));

  const enDias = t.match(/\b(?:en|dentro\s+de)\s+(\d{1,2}|un)\s+dias?\b/);
  if (enDias) agregar(enDias[0], sumarDias(hoy, enDias[1] === 'un' ? 1 : Number(enDias[1])));

  const hoyDia = diaDeSemana(hoy);
  const semanal = new RegExp(`\\b(los\\s+)?(${SEMANA})\\b(\\s+pasado\\b)?(\\s+de\\s+la\\s+(?:proxima|otra)\\s+semana|\\s+de\\s+la\\s+semana\\s+que\\s+viene)?`, 'g');
  for (const m of t.matchAll(semanal)) {
    if (m[1] || m[3]) continue; // "los lunes", "el lunes pasado"
    const dia = DIAS.indexOf(m[2]);
    // Nunca hoy: "el lunes" dicho un lunes es el de la otra semana.
    const dias = m[4]
      ? (((1 - hoyDia + 7) % 7) || 7) + ((dia - 1 + 7) % 7)
      : ((dia - hoyDia + 7) % 7) || 7;
    agregar(m[0].trim(), sumarDias(hoy, dias));
  }
  return halladas;
}

// La fecha, solo si el texto dice exactamente una que pueda ser.
function fechaUnicaDelTexto(texto, hoy = colombiaDateString()) {
  const fechas = fechasDelTexto(texto, hoy);
  return fechas.length === 1 && fechas[0].fecha ? fechas[0].fecha : null;
}

module.exports = { fechasDelTexto, fechaUnicaDelTexto, sinPedidoDeAviso };
