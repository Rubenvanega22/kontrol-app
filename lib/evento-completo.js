// /lib/evento-completo.js — un evento agendado por la IA necesita qué, día y hora.
//
// Revisa lo que el modelo quiere guardar antes de ejecutarlo. Si falta algo, o el modelo
// lo inventó, devuelve UNA pregunta en vez de guardar. Un dato puede venir de un turno
// anterior: "una cita hoy a las 9 y 20" → "¿De qué es la cita?" → "con el dentista".

const { horasHabladas, diceVarios, eventosEnRespuesta, dudaSobreEventos } = require('./horas-habladas');

// Palabras que por sí solas no dicen qué es el evento, con cómo preguntarlo.
const GENERICOS = {
  cita: '¿De qué es la cita?',
  citas: '¿De qué son las citas?',
  reunion: '¿De qué es la reunión?',
  reuniones: '¿De qué son las reuniones?',
  evento: '¿De qué es el evento?',
  eventos: '¿De qué son los eventos?',
  llamada: '¿Con quién es la llamada?',
  visita: '¿De qué es la visita?',
  consulta: '¿De qué es la consulta?',
  encuentro: '¿De qué es el encuentro?',
  compromiso: '¿De qué es el compromiso?',
  actividad: '¿De qué es la actividad?',
  recordatorio: '¿Qué quieres que te recuerde?',
  aviso: '¿Qué quieres que te recuerde?',
  algo: '¿Qué quieres agendar?',
  cosa: '¿Qué quieres agendar?',
  cosas: '¿Qué quieres agendar?',
  pendiente: '¿Qué quieres agendar?',
  tarea: '¿Qué quieres agendar?',
  asunto: '¿Qué quieres agendar?',
  plan: '¿Qué quieres agendar?',
  agenda: '¿Qué quieres agendar?'
};
// Relleno que no aporta al título: "Cita de hoy a las 9" sigue siendo solo "cita".
const RELLENO = new Set([
  'un', 'una', 'unas', 'unos', 'el', 'la', 'las', 'los', 'lo', 'mi', 'mis', 'de', 'del', 'para', 'a', 'al',
  'y', 'con', 'en', 'por', 'hoy', 'manana', 'pasado', 'tarde', 'noche', 'am', 'pm', 'hora', 'horas',
  'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo', 'importante', 'nueva', 'nuevo'
]);

function sinAcentos(texto) {
  return String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function preguntaPorTitulo(titulo) {
  const palabras = sinAcentos(titulo).split(/[^a-z0-9ñ]+/).filter(Boolean)
    .filter(p => !RELLENO.has(p) && !/^\d+$/.test(p));
  if (!palabras.length) return '¿Qué quieres agendar?';
  if (!palabras.every(p => p in GENERICOS)) return null;
  return GENERICOS[palabras[0]];
}

const RELATIVO = /\b(en|dentro de)\s+(\d+|un|una|media|un cuarto de)\s*(hora|horas|minuto|minutos|min|cuarto)\b/;

function mencionaHora(texto) {
  const t = sinAcentos(texto).trim();
  if (horasHabladas(t).length) return true;
  return /\b\d{1,2}:\d{2}\b/.test(t)
    || /\b\d{1,2}\s*(a\.?\s?m\b|p\.?\s?m\b)/.test(t)
    || /\blas?\s+(\d{1,2}|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b/.test(t)
    || /\b(mediodia|medio dia|medianoche|media noche)\b/.test(t)
    || RELATIVO.test(t);
}

function mencionaDia(texto) {
  const t = sinAcentos(texto).replace(/\b(de|por|en) la (manana|tarde|noche)\b/g, ' ');
  return /\b(hoy|manana|pasado|lunes|martes|miercoles|jueves|viernes|sabado|domingo|semana|dias?|esta noche|esta tarde|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/.test(t)
    || /\bel\s+\d{1,2}\b/.test(t)
    || /\b\d{1,2}\/\d{1,2}\b/.test(t)
    || RELATIVO.test(t);
}

// Junta los turnos de esta misma conversación: sube por el historial mientras cada
// respuesta de la IA haya sido una pregunta que el usuario contestó.
function turnosDelPedido(history, mensaje) {
  const h = (history || []).filter(x => x && typeof x.content === 'string');
  if (h.length && h[h.length - 1].role === 'user' && h[h.length - 1].content === mensaje) h.pop();
  const usuario = [];
  const preguntas = [];
  for (let i = h.length - 1; i >= 1 && usuario.length < 6; i -= 2) {
    const ia = h[i], u = h[i - 1];
    if (ia.role !== 'assistant' || u.role !== 'user' || !ia.content.trim().endsWith('?')) break;
    usuario.push(u.content);
    preguntas.push(ia.content);
  }
  return { usuario, preguntas };
}

// Horas dichas en este mensaje o, si aquí no dijo ninguna, en el turno más cercano.
function horasDelPedido(mensaje, history) {
  const propias = horasHabladas(mensaje);
  if (propias.length || mencionaHora(mensaje)) return propias;
  for (const texto of turnosDelPedido(history, mensaje).usuario) {
    const dichas = horasHabladas(texto);
    if (dichas.length) return dichas;
  }
  return [];
}

// Devuelve la pregunta que hay que hacer, o null si se puede guardar.
function preguntaAntesDeGuardar({ mensaje, respuesta, history, conImagen = false }) {
  const eventos = eventosEnRespuesta(respuesta);
  if (!eventos.length) return null;
  const { usuario, preguntas } = turnosDelPedido(history, mensaje);
  const todo = [mensaje, ...usuario].join(' \n ');
  // Al corregir un evento, el día y la hora ya los dijo antes de esta conversación.
  const corrige = /\[ACCION:\s*borrar_evento\b/.test(respuesta);
  // Lo que se lee en una foto no está en el texto; tampoco insistimos si ya contestó esa pregunta.
  const verificarDia = !conImagen && !corrige && !preguntas.some(p => /qu[eé] d[ií]a|para cu[aá]ndo|cu[aá]ndo es/i.test(p));
  const verificarHora = !conImagen && !corrige && !preguntas.some(p => /qu[eé] hora/i.test(p));

  for (const e of eventos) {
    const sobreTitulo = preguntaPorTitulo(e.titulo);
    if (sobreTitulo) return sobreTitulo;
  }
  for (const e of eventos) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.fecha) || (verificarDia && !mencionaDia(todo))) return '¿Para qué día?';
  }
  for (const e of eventos) {
    if (!e.hora || (verificarHora && !mencionaHora(todo))) return '¿A qué hora?';
  }

  if (conImagen) return null;
  return dudaSobreEventos(mensaje, respuesta, {
    dichas: horasDelPedido(mensaje, history),
    varios: diceVarios(mensaje) || usuario.some(diceVarios)
  });
}

module.exports = { preguntaAntesDeGuardar, preguntaPorTitulo, mencionaDia, mencionaHora, turnosDelPedido, horasDelPedido };
