// /lib/mensaje-programado.js — "a las 6:05 escríbele a Paola: ya voy en camino".
//
// El CÓDIGO entiende el pedido (a quién, qué mensaje, a qué hora) y calcula la fecha y la
// hora en Colombia. A la hora, el cron le manda al usuario un enlace wa.me con el mensaje
// ya escrito: el bot nunca le escribe a la otra persona.
// Funciones puras (sin base ni red), probadas en pruebas/probar-mensaje-programado.js.

const { colombiaDateString } = require('./datetime');
const { normalizar, horasHabladas } = require('./horas-habladas');
const { fechasDelTexto } = require('./fechas-habladas');

const TZ = 'America/Bogota';
const MIN = 60 * 1000;
// Una hora dicha hace un par de minutos todavía es "ahora".
const TOLERANCIA_PASADA_MS = 2 * MIN;

// minúsculas sin tildes, CONSERVANDO la longitud (para cortar el texto original).
function base(texto) {
  return String(texto || '').normalize('NFC').split('')
    .map(c => c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().slice(0, 1) || c)
    .join('');
}
function norm(texto) {
  return String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const capitalizar = s => s.replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase());

// "escríbele", "mándale un mensaje", "dile", "recuérdame escribirle"…
const VERBO = '(?:recuerdame\\s+(?:escribirle|decirle|mandarle|enviarle)|escribele|escribale|escribirle|mandale|mandarle|enviale|enviarle|dile|decirle|avisale)';
const CANAL = '(?:\\s+(?:un|el|este|ese)\\s+(?:mensaje|mensajito|whatsapp|wasap|wpp|msj|texto))?';
const PEDIDO = new RegExp(`\\b${VERBO}${CANAL}\\s+(?:a|al)\\s+`, 'i');

// Palabras que terminan el nombre: "a Paola que…", "a Paola a las 6", "a Paola mañana".
const FIN_NOMBRE = new Set(['que', 'diciendo', 'diciendole', 'a', 'al', 'hoy', 'manana', 'pasado', 'el', 'en', 'dentro',
  'y', 'para', 'por', 'de', 'del', 'esta', 'este', 'las', 'la', 'los', 'ya', 'ahora', 'como', 'cuando', 'lunes', 'martes',
  'miercoles', 'jueves', 'viernes', 'sabado', 'domingo', 'con', 'si', 'apenas', 'tipo', 'antes', 'despues', 'mensaje']);

const NUM = '(?:\\d{1,2}|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)';
const MINUTOS = '(?:[:.]\\d{2}|\\s+y\\s+(?:media|cuarto|\\d{1,2}|[a-z]+)|\\s+menos\\s+(?:cuarto|\\d{1,2}|[a-z]+))?';
const PERIODO = '(?:\\s*(?:a\\.?\\s?m\\.?|p\\.?\\s?m\\.?)|\\s+(?:de|en)\\s+la\\s+(?:manana|tarde|noche|madrugada))?';
const DIA = '(?:hoy|pasado\\s+manana|manana|esta\\s+(?:tarde|noche)|(?:el\\s+)?(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)|el\\s+\\d{1,2}(?:\\s+de\\s+[a-z]+)?)';
const HORA = `(?:(?:a|para|como\\s+a)\\s+las?\\s+${NUM}${MINUTOS}${PERIODO}|${NUM}[:.]\\d{2}${PERIODO}|\\d{1,2}\\s*(?:a\\.?\\s?m\\.?|p\\.?\\s?m\\.?)|(?:al\\s+)?(?:mediodia|medio\\s+dia|medianoche)|(?:en|dentro\\s+de)\\s+(?:\\d+|un|una|media)\\s*(?:minutos?|min|horas?|hora)|ahora(?:\\s+mismo)?|ya\\s+mismo|de\\s+una)`;
// Tiempo al comienzo de lo que sigue al nombre: ", mañana a las 6, que…"
const TIEMPO_INICIO = new RegExp(`^[\\s,;.-]*(?:${DIA}|${HORA})\\b`, 'i');
const ENLACE = /^[\s,;:.-]*(?:diciendole\s+que|diciendo\s+que|diciendole|diciendo|que|esto|lo\s+siguiente)?[\s,;:.-]*/i;

function limpiarMensaje(m) {
  let t = String(m || '').trim().replace(/^["“«']+|["”»']+$/g, '').trim();
  t = t.replace(/\.$/, '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

/**
 * ¿El mensaje pide escribirle a alguien? Devuelve { nombre, texto, control } o null.
 * control = lo dicho fuera del mensaje (de ahí salen el día y la hora).
 * nombre/texto pueden venir vacíos: se preguntan.
 */
function detectarMensajeProgramado(mensaje) {
  const original = String(mensaje || '').normalize('NFC');
  const b = base(original);
  const m = b.match(PEDIDO);
  if (!m) return null;
  const antes = original.slice(0, m.index);
  let i = m.index + m[0].length;

  // Nombre: hasta 3 palabras, sin "mi" delante ("a mi mamá" → Mamá).
  const resto = b.slice(i);
  const palabras = [];
  // Una coma, dos puntos o cualquier signo terminan el nombre.
  const re = /([a-zñ]+)(\s+|(?=[^a-zñ\s])|$)/y;
  let p = 0, finNombre = i;
  const mi = resto.match(/^(?:mi|mis)\s+/);
  if (mi) p = mi[0].length;
  re.lastIndex = p;
  let w;
  while (palabras.length < 3 && (w = re.exec(resto))) {
    if (FIN_NOMBRE.has(w[1])) break;
    palabras.push(original.slice(i + w.index, i + w.index + w[1].length));
    finNombre = i + w.index + w[1].length;
    if (!w[2]) break;
  }
  const nombre = palabras.length ? capitalizar(palabras.join(' ')) : '';
  if (!nombre) i = i + p; else i = finNombre;

  // Lo que sigue: tiempos al comienzo, luego "que"/":"/"," y el mensaje.
  let control = antes + ' ' + original.slice(m.index, i);
  let siguiente = original.slice(i);
  for (let n = 0; n < 4; n++) {
    const t = base(siguiente).match(TIEMPO_INICIO);
    if (!t) break;
    control += ' ' + siguiente.slice(0, t[0].length);
    siguiente = siguiente.slice(t[0].length);
  }
  const enlace = base(siguiente).match(ENLACE);
  const texto = limpiarMensaje(siguiente.slice(enlace ? enlace[0].length : 0));
  return { nombre, texto, control: control.trim() };
}

// ─── Hora dicha ───────────────────────────────────────────────
// { ahora } | { relativoMin } | { h, m, periodo: 'am'|'pm'|null } | null
function horaDelTexto(texto) {
  const t = normalizar(texto);
  if (/\b(ahora(?: mismo)?|ya mismo|de una)\b/.test(t)) return { ahora: true };
  const rel = t.match(/\b(?:en|dentro de)\s+(\d+|un|una|media)\s*(minutos?|min|horas?|hora)\b/);
  if (rel) {
    const n = rel[1] === 'media' ? 0.5 : (rel[1] === 'un' || rel[1] === 'una') ? 1 : Number(rel[1]);
    const min = /^h/.test(rel[2]) ? n * 60 : n;
    if (min > 0 && min <= 24 * 60) return { relativoMin: Math.round(min) };
  }
  if (/\b(mediodia|medio dia)\b/.test(t)) return { h: 12, m: 0, periodo: 'pm' };
  if (/\bmedianoche\b/.test(t)) return { h: 0, m: 0, periodo: 'am' };

  let h = null, mm = 0, fin = -1;
  const hablada = horasHabladas(t)[0];
  if (hablada) {
    [h, mm] = hablada.hora.split(':').map(Number);
    fin = t.indexOf(hablada.dicho) + hablada.dicho.length;
  } else {
    const conMin = t.match(/\b(\d{1,2})[:.](\d{2})\b/);
    const sufijo = t.match(/\b(\d{1,2})\s*(?=a\.?\s?m\b|p\.?\s?m\b|am\b|pm\b)/);
    const lasN = t.match(/\blas?\s+(\d{1,2})\b(?!\s*(?:de\s+)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|dias?|horas?|minutos?|personas?|mil|pesos)\b)/);
    const hallada = conMin || sufijo || lasN;
    if (!hallada) return null;
    h = Number(hallada[1]);
    mm = conMin ? Number(conMin[2]) : 0;
    fin = hallada.index + hallada[0].length;
  }
  if (!(h >= 0 && h <= 23 && mm >= 0 && mm <= 59)) return null;
  const despues = t.slice(fin);
  let periodo = null;
  if (/^\s*(a\.?\s?m\b|am\b)/.test(despues) || /^\s+(de|en) la (manana|madrugada)\b/.test(despues)) periodo = 'am';
  else if (/^\s*(p\.?\s?m\b|pm\b)/.test(despues) || /^\s+(de|en|por) la (tarde|noche)\b/.test(despues) || /\besta (tarde|noche)\b/.test(t)) periodo = 'pm';
  return { h, m: mm, periodo };
}

// Hora de 24 con la hora dicha, o null si no se sabe si es am o pm.
function a24({ h, m, periodo }) {
  if (h >= 13 || h === 0) return { h, m };
  if (periodo === 'am') return { h: h === 12 ? 0 : h, m };
  if (periodo === 'pm') return { h: h === 12 ? 12 : h + 12, m };
  if (h === 12) return { h: 12, m };
  return null;
}

const dosDigitos = n => String(n).padStart(2, '0');
const instante = (fecha, h, m) => new Date(`${fecha}T${dosDigitos(h)}:${dosDigitos(m)}:00-05:00`);
function sumarDias(fecha, dias) {
  return colombiaDateString(new Date(new Date(`${fecha}T12:00:00-05:00`).getTime() + dias * 86400000));
}
function partesColombia(date) {
  const [fecha, hora] = date.toLocaleString('sv-SE', { timeZone: TZ }).split(' ');
  return { fecha, hora: hora.slice(0, 5) };
}

/**
 * Resuelve el momento. Devuelve:
 *   { ahora: true }
 *   { fecha, hora }                          → listo para guardar
 *   { pregunta: 'ampm', h, m, fecha }        → "¿6:05 de la mañana o de la tarde?"
 *   { pregunta: 'manana', fecha, hora }      → ya pasó hoy; se propone mañana
 *   { pregunta: 'hora' }                     → no dijo hora
 */
function resolverMomento(horaDicha, fechaDicha, ahoraDate = new Date()) {
  const ahoraMs = ahoraDate.getTime();
  const hoy = colombiaDateString(ahoraDate);
  if (!horaDicha) return { pregunta: 'hora' };
  if (horaDicha.ahora) return { ahora: true };
  if (horaDicha.relativoMin) return partesColombia(new Date(ahoraMs + horaDicha.relativoMin * MIN));

  const fecha = fechaDicha || hoy;
  const exacta = a24(horaDicha);
  if (!exacta) {
    // Sin am/pm y para hoy: la próxima vez que ocurre esa hora.
    if (fecha === hoy) {
      for (const h of [horaDicha.h, horaDicha.h + 12]) {
        if (instante(fecha, h, horaDicha.m).getTime() > ahoraMs - TOLERANCIA_PASADA_MS) {
          return { fecha, hora: `${dosDigitos(h)}:${dosDigitos(horaDicha.m)}` };
        }
      }
      return { pregunta: 'manana', fecha: sumarDias(hoy, 1), hora: `${dosDigitos(horaDicha.h)}:${dosDigitos(horaDicha.m)}` };
    }
    return { pregunta: 'ampm', h: horaDicha.h, m: horaDicha.m, fecha };
  }
  const hora = `${dosDigitos(exacta.h)}:${dosDigitos(exacta.m)}`;
  if (instante(fecha, exacta.h, exacta.m).getTime() <= ahoraMs - TOLERANCIA_PASADA_MS) {
    // Solo pasa con "hoy": las demás fechas dichas siempre son futuras.
    return { pregunta: 'manana', fecha: sumarDias(hoy, 1), hora };
  }
  return { fecha, hora };
}

// Fecha única dicha en el texto; si dijo varias o una imposible, null (y se usa hoy).
function fechaDelTexto(texto, hoy = colombiaDateString()) {
  const f = fechasDelTexto(texto, hoy).filter(x => x.fecha);
  return f.length === 1 ? f[0].fecha : null;
}

// ─── Teléfonos ────────────────────────────────────────────────
// "300 123 4567", "+57 300…", "573001234567", "+1 555 123 4567" → E.164. Si no, null.
// Igual que normalizarTelefono() de index.html ("0057…" y marcas invisibles de Android incluidas).
function normalizarTelefono(texto) {
  const t = String(texto || '').replace(/[‎‏‪-‮⁦-⁩]/g, '');
  let d = t.replace(/\D/g, '');
  let conMas = /\+\s*\d/.test(t);
  if (!conMas && d.startsWith('00')) { d = d.slice(2); conMas = true; }
  if (conMas) return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  if (d.length === 10 && d.startsWith('3')) return `+57${d}`;
  if (d.length === 12 && d.startsWith('573')) return `+${d}`;
  return null;
}

function enlaceWa(telefono, texto) {
  const numero = String(telefono || '').replace(/\D/g, '');
  return `https://wa.me/${numero}?text=${encodeURIComponent(texto || '')}`;
}

// ─── Contactos ────────────────────────────────────────────────
// Exacto primero; si no, los que empiezan por el nombre o lo tienen como palabra.
function elegirContacto(contactos, nombre) {
  const n = norm(nombre);
  if (!n) return [];
  const exactos = contactos.filter(c => norm(c.nombre) === n);
  if (exactos.length) return exactos;
  return contactos.filter(c => {
    const cn = norm(c.nombre);
    return cn.startsWith(n + ' ') || cn.split(' ').includes(n);
  });
}

// ─── Textos ───────────────────────────────────────────────────
function hora12(hora) {
  const [h, m] = hora.split(':').map(Number);
  const sufijo = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${dosDigitos(m)} ${sufijo}`;
}
function cuandoTexto(fecha, hoy = colombiaDateString()) {
  if (fecha === hoy) return 'Hoy';
  if (fecha === sumarDias(hoy, 1)) return 'Mañana';
  const d = new Date(`${fecha}T12:00:00-05:00`);
  const dia = d.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });
  return `El ${dia}`;
}

module.exports = {
  detectarMensajeProgramado, horaDelTexto, resolverMomento, fechaDelTexto, a24,
  normalizarTelefono, enlaceWa, elegirContacto, hora12, cuandoTexto, norm, sumarDias
};
