// /lib/horas-habladas.js — formas colombianas de decir la hora.
// "las 9 y 10" = 9:10 · "9 y media" = 9:30 · "9 y cuarto" = 9:15
// "un cuarto para las 10" = 9:45 · "5 para las 10" = 9:55 · "10 menos 5" = 9:55
//
// El modelo se equivocó con la misma frase de formas distintas, así que el código la
// interpreta antes de llamarlo y revisa lo que quiere guardar antes de ejecutarlo.

const UNIDADES = { uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9 };
const SIMPLES = {
  ...UNIDADES, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16,
  diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22,
  veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27,
  veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50
};

function sinAcentos(texto) {
  return String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Whisper a veces escribe los números en letras: "las nueve y diez" → "las 9 y 10".
function normalizar(texto) {
  return sinAcentos(texto)
    .replace(/\b(treinta|cuarenta|cincuenta) y (uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\b/g,
      (_, d, u) => String(SIMPLES[d] + UNIDADES[u]))
    .replace(/\bla una\b/g, 'la 1')
    .replace(/\b[a-z]+\b/g, p => (p in SIMPLES ? String(SIMPLES[p]) : p))
    .replace(/\s+/g, ' ')
    .trim();
}

const NO_ES_HORA = '(?!\\s*(?:de\\s+)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|personas?|mil|pesos|dias|horas)\\b)';

function aTexto(h, m) {
  return `${h}:${String(m).padStart(2, '0')}`;
}

function horaValida(h) { return h >= 0 && h <= 23; }

function horaAnterior(h) {
  if (h === 1) return 12;
  return h === 0 ? 23 : h - 1;
}

function restar(h, min) {
  return aTexto(horaAnterior(h), 60 - min);
}

// Devuelve [{ dicho, hora }] con la hora en reloj de 12 o 24 según se dijo; el am/pm
// no sale de estas frases.
function horasHabladas(texto) {
  const t = normalizar(texto);
  const halladas = [];
  const agregar = (m, hora) => halladas.push({ inicio: m.index, fin: m.index + m[0].length, dicho: m[0].trim(), hora });

  // "un cuarto para las 10", "5 para las 10", "faltan 10 minutos para las 8"
  for (const m of t.matchAll(/\b(?:un\s+)?(cuarto|\d{1,2})(?:\s+minutos)?\s+para\s+las?\s+(\d{1,2})\b/g)) {
    const min = m[1] === 'cuarto' ? 15 : Number(m[1]);
    const h = Number(m[2]);
    if (min >= 1 && min <= 30 && horaValida(h)) agregar(m, restar(h, min));
  }
  // "las 10 menos 5", "las 10 menos cuarto"
  for (const m of t.matchAll(/\blas?\s+(\d{1,2})\s+menos\s+(?:un\s+)?(cuarto|\d{1,2})\b/g)) {
    const min = m[2] === 'cuarto' ? 15 : Number(m[2]);
    const h = Number(m[1]);
    if (min >= 1 && min <= 30 && horaValida(h)) agregar(m, restar(h, min));
  }
  // "las 9 y media", "las 9 y cuarto", "las 9 y 10"
  const conY = new RegExp(`\\blas?\\s+(\\d{1,2})\\s+y\\s+(media|cuarto|\\d{1,2})\\b(?:\\s+minutos\\b)?${NO_ES_HORA}`, 'g');
  for (const m of t.matchAll(conY)) {
    const h = Number(m[1]);
    const min = m[2] === 'media' ? 30 : m[2] === 'cuarto' ? 15 : Number(m[2]);
    if (horaValida(h) && min >= 0 && min <= 59) agregar(m, aTexto(h, min));
  }

  return halladas
    .filter((a, i) => !halladas.some((b, j) => j !== i && b.inicio <= a.inicio && b.fin >= a.fin && (b.fin - b.inicio) > (a.fin - a.inicio)))
    .sort((a, b) => a.inicio - b.inicio)
    .map(({ dicho, hora }) => ({ dicho, hora }));
}

// ¿Dijo claramente que son varios? "dos citas", "una a las 9 y otra a las 10",
// "a las 9 y a las 10". "a las dos" es una hora, y "unas citas" no aclara cuántas.
function diceVarios(texto) {
  const t = sinAcentos(texto);
  if (/\b(otra|otro|otras|otros|ambas|ambos|cada una|cada uno|tres|cuatro)\b/.test(t)) return true;
  if (/(?<!\blas\s)(?<!\ba\sla\s)\bdos\b/.test(t)) return true;
  return (normalizar(t).match(/\blas?\s+\d{1,2}\b/g) || []).length >= 2;
}

function mismaHora(hora24, hablada) {
  const [h, m] = hora24.split(':').map(Number);
  const [hh, mm] = hablada.split(':').map(Number);
  return h % 12 === hh % 12 && m === mm;
}

function hora12(hora24) {
  const [h, m] = hora24.split(':').map(Number);
  return aTexto(h % 12 === 0 ? 12 : h % 12, m);
}

// Lee los [ACCION:evento|titulo|fecha|hora...] de la respuesta del modelo.
function eventosEnRespuesta(respuesta) {
  return [...String(respuesta || '').matchAll(/\[ACCION:\s*evento\s*\|([^\]]*)\]/g)].map(m => {
    const [titulo = '', fecha = '', hora = ''] = m[1].split('|').map(s => s.trim());
    const h = hora.match(/^(\d{1,2}):(\d{2})$/);
    return { titulo, fecha, hora: h ? `${h[1].padStart(2, '0')}:${h[2]}` : null };
  });
}

// Si lo que el modelo va a guardar choca con lo que dijo el usuario, devuelve la pregunta
// que hay que hacerle en vez de guardar. Si no hay duda, devuelve null.
function dudaSobreEventos(mensaje, respuesta) {
  const eventos = eventosEnRespuesta(respuesta).filter(e => e.hora);
  if (!eventos.length) return null;
  const dichas = horasHabladas(mensaje);

  const grupos = {};
  for (const e of eventos) {
    const clave = `${sinAcentos(e.titulo)}|${e.fecha}`;
    (grupos[clave] = grupos[clave] || []).push(e);
  }
  const repetido = Object.values(grupos).find(g => g.length > 1);
  if (repetido && !diceVarios(mensaje)) {
    const horas = repetido.map(e => hora12(e.hora)).join(' y a las ');
    const unaSola = dichas.length === 1 ? ` a las ${dichas[0].hora}` : '';
    return `¿"${repetido[0].titulo}" es una sola vez${unaSola}, o son ${repetido.length}, a las ${horas}?`;
  }

  if (dichas.length === 1 && eventos.length === 1 && !mismaHora(eventos[0].hora, dichas[0].hora)) {
    return `¿Te agendo "${eventos[0].titulo}" a las ${dichas[0].hora}?`;
  }
  return null;
}

module.exports = { horasHabladas, diceVarios, eventosEnRespuesta, dudaSobreEventos };
