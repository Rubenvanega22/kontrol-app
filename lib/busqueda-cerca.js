// /lib/busqueda-cerca.js — Detecta en el CÓDIGO cuándo piden un lugar cercano.
//
// Antes, buscar_cerca solo se activaba si el modelo escribía el marker
// [ACCION:buscar_cerca|…]. Si no lo escribía, respondía por su cuenta con un lugar
// inventado ("un centro comercial a 18 minutos"). Ahora:
//   1. detectarBusquedaCerca(): si el pedido dice claro que busca un lugar cerca
//      ("la ferretería más cerca", "búscame una droguería", "dónde hay un cajero"),
//      ai-chat activa buscar_cerca directo, sin pasar por el modelo.
//   2. respuestaInventaLugar(): si el modelo igual responde con nombres de lugares,
//      direcciones o tiempos de llegada sin haber usado buscar_cerca, ai-chat
//      descarta esa respuesta. Ningún lugar recomendado sale de otro lado que no
//      sea Google Places.
// Sirve igual para texto y para audio: whatsapp.js manda la transcripción a ai-chat.
// Funciones puras (sin base ni red), probadas en pruebas/probar-busqueda-cerca.js.

// minúsculas, sin tildes ni signos (deja # para las direcciones).
function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[¿?¡!.,;:"'()*_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Lugar (normalizado, regex sin límites de palabra) → [consulta para mostrar, tipo de Google].
// Tipo vacío = búsqueda por texto. Los de varias palabras y los más largos van primero
// para que "bomba de gasolina" gane a "gasolina" y "barberia" no se lea como "bar".
const LUGARES = [
  ['bombas? de gasolina', 'gasolinera', 'gas_station'],
  ['estacion(es)? de servicio', 'gasolinera', 'gas_station'],
  ['cajeros? automaticos?', 'cajero', 'atm'],
  ['centros? comerciales?', 'centro comercial', 'shopping_mall'],
  ['ferreterias?', 'ferretería', 'hardware_store'],
  ['droguerias?', 'droguería', 'pharmacy'],
  ['farmacias?', 'farmacia', 'pharmacy'],
  ['cajeros?', 'cajero', 'atm'],
  ['bancos?', 'banco', 'bank'],
  ['gasolineras?', 'gasolinera', 'gas_station'],
  ['gasolina', 'gasolinera', 'gas_station'],
  ['supermercados?', 'supermercado', 'supermarket'],
  ['minimercados?|autoservicios?', 'minimercado', 'convenience_store'],
  ['tiendas?', 'tienda', 'convenience_store'],
  ['hospital(es)?', 'hospital', 'hospital'],
  ['clinicas?', 'clínica', 'hospital'],
  ['urgencias', 'urgencias', 'hospital'],
  ['odontologos?|dentistas?', 'odontólogo', 'dentist'],
  ['medicos?|doctor(es)?', 'médico', 'doctor'],
  ['veterinarias?|veterinarios?', 'veterinaria', 'veterinary_care'],
  ['panaderias?', 'panadería', 'bakery'],
  ['restaurantes?', 'restaurante', 'restaurant'],
  ['cafeterias?', 'cafetería', 'cafe'],
  ['licoreras?|estancos?', 'licorera', 'liquor_store'],
  ['barberias?', 'barbería', 'hair_care'],
  ['peluquerias?', 'peluquería', 'hair_care'],
  ['bares', 'bar', 'bar'],
  ['bar', 'bar', 'bar'],
  ['talleres?( de motos| de carros| mecanicos?)?', 'taller', 'car_repair'],
  ['montallantas', 'montallantas', ''],
  ['lavaderos?( de carros| de motos)?', 'lavadero', 'car_wash'],
  ['parqueaderos?', 'parqueadero', 'parking'],
  ['gimnasios?', 'gimnasio', 'gym'],
  ['lavanderias?', 'lavandería', 'laundry'],
  ['floristerias?', 'floristería', 'florist'],
  ['librerias?', 'librería', 'book_store'],
  ['zapaterias?', 'zapatería', 'shoe_store'],
  ['papelerias?', 'papelería', ''],
  ['cerrajer(o|os|ia|ias)', 'cerrajería', ''],
  ['carnicerias?', 'carnicería', ''],
  ['fruterias?', 'frutería', ''],
  ['hoteles?', 'hotel', 'hotel'],
  ['policia|cai', 'policía', 'police'],
].map(([patron, consulta, tipo]) => ({ re: new RegExp(`\\b(${patron})\\b`), consulta, tipo }));

// Palabras que, tras "de", NO son una marca ("cajero de mi barrio", "farmacia de turno" sí lo es).
const NO_MARCA = new Set(['mi', 'aqui', 'aca', 'la', 'el', 'los', 'las', 'un', 'una', 'por', 'cerca', 'donde', 'mas', 'turno', 'confianza']);

// "Más cerca", "cerca de mí", "por aquí"... ("cerca del parque" o "cerca al banco" no:
// eso dice dónde está algo, no que busque un lugar).
const FRASE_CERCA = /\b(mas cerca(no|na|nos|nas)?|cercan(o|a|os|as)|cerca de (mi|aqui|aca|donde estoy)|por (aqui|aca)( cerca)?|cerca(?!\s+(del|de la|de el|de los|de las|al|a la|a el)\b))\b/;
// "Búscame…", "dónde hay…", "necesito una…" (necesitan además un lugar del diccionario).
const FRASE_BUSCA = /\b(buscame|busca(me|nos)?|busquen|encuentrame|ubicame|donde (hay|queda|quedan|consigo|compro|encuentro|puedo|echo|tanqueo)|hay (algun|alguna|un|una)|necesito (un|una|el|la|ir a)|conoces (algun|alguna|un|una)|recomiendame (un|una|algun|alguna))\b/;
// Pedidos de la app (agenda, pagos, listados…) o de ruta: no son buscar un lugar cercano.
const OTRO_TEMA = /\b(recordatorios?|pagos?|agenda|agendar|agendame|evento|listados?|lista|cita|reunion|ingresos?|caja|clave|comprobante|factura|como llego|llevame|ruta|guardad[oa]s?|mis lugares|mi ubicacion guardada)\b/;

// Lugar nombrado en el texto (del diccionario), con su marca si la dijo
// ("cajero de Bancolombia" → consulta "cajero Bancolombia", búsqueda por texto).
function lugarDelTexto(t) {
  for (const l of LUGARES) {
    const m = t.match(l.re);
    if (!m) continue;
    const despues = t.slice(m.index + m[0].length).match(/^ (de|del) ([a-z0-9]+)( [a-z0-9]+)?/);
    if (despues && !NO_MARCA.has(despues[2])) {
      const marca = despues[2] + (despues[3] && !NO_MARCA.has(despues[3].trim()) && !/^ cerca/.test(despues[3]) ? despues[3] : '');
      return { consulta: `${l.consulta} ${marca}`, tipo: '' };
    }
    return { consulta: l.consulta, tipo: l.tipo };
  }
  return null;
}

// Sin lugar del diccionario: "un sitio de arepas cerca" → "sitio de arepas".
function lugarLibre(t) {
  const m = t.match(/\b(un|una|algun|alguna|el|la)\s+((?:[a-z0-9]+\s+){0,3}?[a-z0-9]+)\s+(mas cerca|cercan[oa]|cerca|por aqui|por aca)\b/);
  if (!m) return null;
  const palabras = m[2].trim();
  if (palabras.length < 3) return null;
  return { consulta: palabras, tipo: '' };
}

/**
 * ¿El mensaje pide buscar un lugar cercano? Devuelve { consulta, tipo } o null.
 *
 * @param {string} mensaje  Texto del usuario o transcripción del audio.
 * @param {{ flexible?: boolean }} [opciones]  flexible: basta con que nombre un
 *        lugar del diccionario (se usa cuando el modelo ya respondió con un lugar
 *        inventado y hay que saber qué buscaba).
 */
function detectarBusquedaCerca(mensaje, { flexible = false } = {}) {
  const t = normalizar(mensaje);
  if (!t || OTRO_TEMA.test(t)) return null;
  const lugar = lugarDelTexto(t);
  if (flexible) return lugar;
  const cerca = FRASE_CERCA.test(t);
  if (lugar && (cerca || FRASE_BUSCA.test(t))) return lugar;
  if (!lugar && cerca) return lugarLibre(t);
  return null;
}

// Señales de que una respuesta recomienda un lugar concreto.
const TIEMPO_LLEGADA = /\b\d+\s*(min|mins|minutos?|cuadras?|km|kilometros?|metros?)\b|\bmedia hora\b/;
const DIRECCION = /\b(calle|cl|carrera|cra|kr|cr|avenida|av|diagonal|dg|transversal|tv)\s*\d+|#\s*\d+/;
const LUGAR_CONCRETO = /\b(centro comercial|queda en|quedan en|esta ubicad[oa]|se encuentra en|te recomiendo|puedes ir a|el mas cercano es|la mas cercana es)\b/;
const ENLACE_MAPS = /maps\.google|google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl/;
// El mensaje del usuario pregunta por un sitio (aunque no lo haya detectado arriba).
const PREGUNTA_SITIO = /\b(donde|cerca|cercan[oa]|queda|quedan|llegar|busca|buscame|ubica|hay|recomienda|recomiendas|recomiendame|conoces|consigo|compro)\b/;

/**
 * ¿El modelo respondió con un lugar que no salió de Google Places?
 *
 * @param {string} respuesta  Texto visible del modelo (sin markers).
 * @param {string} mensaje    Lo que pidió el usuario.
 * @param {string[]} [guardados]  Nombres de los lugares guardados del usuario: si la
 *        respuesta habla de uno de ellos, no es un lugar inventado.
 */
function respuestaInventaLugar(respuesta, mensaje, guardados = []) {
  const r = normalizar(respuesta);
  if (!r) return false;
  const nombres = guardados.map(normalizar).filter(n => n.length >= 3);
  if (nombres.some(n => r.includes(n))) return false;
  const senal = TIEMPO_LLEGADA.test(r) || DIRECCION.test(r) || LUGAR_CONCRETO.test(r) || ENLACE_MAPS.test(String(respuesta).toLowerCase());
  if (!senal) return false;
  const m = normalizar(mensaje);
  return !!detectarBusquedaCerca(mensaje, { flexible: true }) || (PREGUNTA_SITIO.test(m) && !OTRO_TEMA.test(m));
}

const PREGUNTAR_LUGAR = '¿Qué lugar te busco? Dime qué necesitas (por ejemplo, una droguería o un cajero) y lo busco cerca de ti.';

module.exports = { detectarBusquedaCerca, respuestaInventaLugar, normalizar, PREGUNTAR_LUGAR };
