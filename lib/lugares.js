// /lib/lugares.js — Lugares cercanos (Google Places API New) y enlaces de ruta.
//
// La clave vive solo en Vercel (GOOGLE_PLACES_KEY) y solo la usa el servidor.
// Los resultados salen tal cual los devuelve Google: si no hay nada, se dice.
// Cada llamada a Places queda en busquedas_lugares para los topes diarios.

const supabase = require('./supabase');
const { colombiaDateString } = require('./datetime');

const PLACES_KEY = process.env.GOOGLE_PLACES_KEY;
const PLACES_URL = 'https://places.googleapis.com/v1/places';
const TZ = 'America/Bogota';

const UBICACION_VIGENTE_MS = 30 * 60 * 1000;
const PENDIENTE_VIGENTE_MS = 10 * 60 * 1000;
const TOPE_USUARIO_DIA = 20;
const TOPE_TOTAL_DIA = 33;
const RADIO_CORTO = 3000;
const RADIO_LARGO = 8000;
const MIN_ESTRELLAS = 3.8;
const MIN_RESENAS = 20;

// Estrellas, reseñas y horario hacen que la búsqueda cobre como Enterprise.
const CAMPOS = [
  'places.id', 'places.displayName', 'places.shortFormattedAddress', 'places.formattedAddress',
  'places.location', 'places.rating', 'places.userRatingCount', 'places.businessStatus',
  'places.currentOpeningHours.openNow', 'places.currentOpeningHours.nextCloseTime',
  'places.currentOpeningHours.nextOpenTime'
].join(',');

// Tipos de Google que el modelo puede pedir. Otro tipo, o ninguno, va por búsqueda de texto.
const TIPOS = {
  pharmacy: ['pharmacy', 'drugstore'], drugstore: ['pharmacy', 'drugstore'],
  gas_station: ['gas_station'], hardware_store: ['hardware_store'],
  supermarket: ['supermarket', 'grocery_store'], grocery_store: ['grocery_store', 'supermarket'],
  convenience_store: ['convenience_store'], atm: ['atm'], bank: ['bank'],
  hospital: ['hospital'], doctor: ['doctor'], dentist: ['dentist'],
  veterinary_care: ['veterinary_care'], pet_store: ['pet_store'],
  restaurant: ['restaurant'], fast_food_restaurant: ['fast_food_restaurant'],
  cafe: ['cafe'], bakery: ['bakery'], bar: ['bar'], liquor_store: ['liquor_store'],
  car_repair: ['car_repair'], car_wash: ['car_wash'], parking: ['parking'],
  electric_vehicle_charging_station: ['electric_vehicle_charging_station'],
  shopping_mall: ['shopping_mall'], police: ['police'], post_office: ['post_office'],
  laundry: ['laundry'], hair_care: ['hair_care'], beauty_salon: ['beauty_salon'],
  gym: ['gym'], electronics_store: ['electronics_store'], clothing_store: ['clothing_store'],
  shoe_store: ['shoe_store'], book_store: ['book_store'], florist: ['florist'],
  bicycle_store: ['bicycle_store'], lodging: ['lodging'], hotel: ['hotel']
};

// ─── Ubicación del usuario ────────────────────────────────────
async function guardarUbicacionActual(userId, lat, lng) {
  const { error } = await supabase.from('profiles')
    .update({ ubicacion_lat: lat, ubicacion_lng: lng, ubicacion_at: new Date().toISOString() })
    .eq('id', userId);
  if (error) console.error('[lugares] guardar ubicación error:', error.message);
}

// {lat, lng} si la última ubicación tiene 30 minutos o menos; si no, null.
async function ubicacionReciente(userId) {
  const { data, error } = await supabase.from('profiles')
    .select('ubicacion_lat, ubicacion_lng, ubicacion_at').eq('id', userId).maybeSingle();
  if (error) { console.error('[lugares] leer ubicación error:', error.message); return null; }
  if (!data?.ubicacion_at || data.ubicacion_lat == null || data.ubicacion_lng == null) return null;
  if (Date.now() - new Date(data.ubicacion_at).getTime() > UBICACION_VIGENTE_MS) return null;
  return { lat: data.ubicacion_lat, lng: data.ubicacion_lng };
}

async function dejarPendiente(userId, consulta, tipo) {
  const { error } = await supabase.from('profiles')
    .update({ busqueda_pendiente: { consulta, tipo: tipo || null, at: new Date().toISOString() } })
    .eq('id', userId);
  if (error) console.error('[lugares] guardar pendiente error:', error.message);
}

// Devuelve la búsqueda pendiente si sigue vigente y la borra en cualquier caso.
async function tomarPendiente(userId) {
  const { data, error } = await supabase.from('profiles')
    .select('busqueda_pendiente').eq('id', userId).maybeSingle();
  if (error) { console.error('[lugares] leer pendiente error:', error.message); return null; }
  const p = data?.busqueda_pendiente;
  if (!p) return null;
  await supabase.from('profiles').update({ busqueda_pendiente: null }).eq('id', userId);
  if (!p.at || Date.now() - new Date(p.at).getTime() > PENDIENTE_VIGENTE_MS) return null;
  return p;
}

// ─── Topes diarios ────────────────────────────────────────────
async function busquedasDeHoy(userId) {
  const desde = new Date(`${colombiaDateString()}T00:00:00-05:00`).toISOString();
  const [total, propias] = await Promise.all([
    supabase.from('busquedas_lugares').select('id', { count: 'exact', head: true }).gte('created_at', desde),
    supabase.from('busquedas_lugares').select('id', { count: 'exact', head: true }).gte('created_at', desde).eq('user_id', userId)
  ]);
  if (total.error || propias.error) {
    console.error('[lugares] contar búsquedas error:', (total.error || propias.error).message);
    return null;
  }
  return { total: total.count || 0, propias: propias.count || 0 };
}

function topeAlcanzado(uso) {
  if (!uso) return 'No pude revisar el límite de búsquedas. Intenta en un momento.';
  if (uso.propias >= TOPE_USUARIO_DIA) return `Ya hiciste las ${TOPE_USUARIO_DIA} búsquedas de lugares de hoy. Mañana puedes seguir.`;
  if (uso.total >= TOPE_TOTAL_DIA) return 'Por hoy se acabaron las búsquedas de lugares. Mañana vuelven a estar disponibles.';
  return null;
}

async function anotarBusqueda(userId, consulta, tipo, resultados) {
  const { error } = await supabase.from('busquedas_lugares').insert({
    user_id: userId, consulta: (consulta || '').slice(0, 200), tipo: tipo || null, resultados
  });
  if (error) console.error('[lugares] anotar búsqueda error:', error.message);
}

// ─── Google Places ────────────────────────────────────────────
async function llamarPlaces(ruta, cuerpo) {
  const r = await fetch(`${PLACES_URL}:${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': CAMPOS },
    body: JSON.stringify(cuerpo)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`Places ${ruta} ${r.status}: ${data.error?.status || ''} ${data.error?.message || ''}`);
    err.status = r.status;
    throw err;
  }
  return data.places || [];
}

function circulo(origen, radio) {
  return { circle: { center: { latitude: origen.lat, longitude: origen.lng }, radius: radio } };
}

async function porTipo(origen, tipos, radio) {
  return llamarPlaces('searchNearby', {
    includedTypes: tipos, maxResultCount: 20, rankPreference: 'DISTANCE',
    locationRestriction: circulo(origen, radio), languageCode: 'es', regionCode: 'CO'
  });
}

async function porTexto(origen, consulta, radio) {
  const lugares = await llamarPlaces('searchText', {
    textQuery: consulta, pageSize: 20, rankPreference: 'DISTANCE',
    locationBias: circulo(origen, radio), languageCode: 'es', regionCode: 'CO'
  });
  // locationBias solo inclina la búsqueda: lo que quede fuera del radio no es "cerca".
  return lugares.filter(p => p.location && metros(origen, p.location) <= radio);
}

// ─── Orden y formato ──────────────────────────────────────────
function metros(a, p) {
  const rad = x => x * Math.PI / 180;
  const lat2 = p.latitude ?? p.lat, lng2 = p.longitude ?? p.lng;
  const dLat = rad(lat2 - a.lat), dLng = rad(lng2 - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const buenaCalificacion = p => (p.rating || 0) >= MIN_ESTRELLAS && (p.userRatingCount || 0) >= MIN_RESENAS;

// Primero abiertos, luego bien calificados, luego los más cercanos.
function ordenar(origen, lugares) {
  const vistos = new Set();
  return lugares
    .filter(p => p.location && p.businessStatus !== 'CLOSED_PERMANENTLY' && p.businessStatus !== 'CLOSED_TEMPORARILY')
    .filter(p => !vistos.has(p.id) && vistos.add(p.id))
    .map(p => ({ ...p, distancia: metros(origen, p.location) }))
    .sort((a, b) => {
      const abierto = p => (p.currentOpeningHours?.openNow === true ? 0 : p.currentOpeningHours?.openNow === false ? 2 : 1);
      return (abierto(a) - abierto(b))
        || (Number(buenaCalificacion(b)) - Number(buenaCalificacion(a)))
        || (a.distancia - b.distancia);
    });
}

function textoDistancia(m) {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

function horaColombia(iso) {
  return new Date(iso).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ });
}

// Si cierra o abre otro día, se dice qué día.
function cuando(iso) {
  const dia = new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
  const hoy = colombiaDateString();
  const manana = colombiaDateString(new Date(Date.now() + 24 * 3600 * 1000));
  const hora = horaColombia(iso);
  if (dia === hoy) return hora;
  if (dia === manana) return `mañana ${hora}`;
  const nombre = new Date(iso).toLocaleDateString('es-CO', { weekday: 'long', timeZone: TZ });
  return `el ${nombre} ${hora}`;
}

function textoHorario(h) {
  if (!h || typeof h.openNow !== 'boolean') return 'Horario no disponible';
  if (h.openNow) return h.nextCloseTime ? `🟢 Abierto hasta ${cuando(h.nextCloseTime)}` : '🟢 Abierto 24 horas';
  return h.nextOpenTime ? `🔴 Cerrado, abre ${cuando(h.nextOpenTime)}` : '🔴 Cerrado';
}

function textoEstrellas(p) {
  if (!p.rating) return 'Sin calificación';
  return `⭐ ${p.rating.toFixed(1).replace('.', ',')} (${p.userRatingCount || 0})`;
}

// Maps calcula la mejor ruta con tráfico en vivo al abrir el enlace.
function enlaceRuta(origen, destino, placeId) {
  const q = new URLSearchParams({ api: '1' });
  if (origen) q.set('origin', `${origen.lat},${origen.lng}`);
  q.set('destination', destino);
  if (placeId) q.set('destination_place_id', placeId);
  return `https://www.google.com/maps/dir/?${q.toString()}`;
}

function formatear(origen, consulta, mejores) {
  const lineas = mejores.map((p, i) => {
    const nombre = p.displayName?.text || 'Sin nombre';
    const direccion = p.shortFormattedAddress || p.formattedAddress || '';
    return [
      `${i + 1}. *${nombre}* · ${textoDistancia(p.distancia)}`,
      `${textoHorario(p.currentOpeningHours)} · ${textoEstrellas(p)}`,
      direccion,
      `Cómo llegar: ${enlaceRuta(origen, nombre, p.id)}`
    ].filter(Boolean).join('\n');
  });
  const titulo = consulta.charAt(0).toUpperCase() + consulta.slice(1);
  return `📍 ${titulo} cerca de ti:\n\n${lineas.join('\n\n')}`;
}

// ─── Búsqueda completa: topes → Places (3 km, si faltan 8 km) → orden → texto ──
async function buscarCerca(userId, origen, { consulta, tipo }) {
  consulta = (consulta || '').trim();
  if (!consulta) return '¿Qué lugar te busco?';
  if (!PLACES_KEY) {
    console.error('[lugares] falta GOOGLE_PLACES_KEY');
    return 'La búsqueda de lugares no está configurada todavía.';
  }
  const tipos = TIPOS[(tipo || '').trim()] || null;

  const buscar = async radio => {
    const tope = topeAlcanzado(await busquedasDeHoy(userId));
    if (tope) return { tope };
    let lugares;
    try {
      lugares = tipos ? await porTipo(origen, tipos, radio) : await porTexto(origen, consulta, radio);
    } catch (e) {
      console.error('[lugares]', e.message);
      // Un tipo que Google no acepta no debe dejar sin respuesta: se intenta por texto.
      if (tipos && e.status === 400) lugares = await porTexto(origen, consulta, radio).catch(() => null);
      if (!lugares) return { error: true };
    }
    await anotarBusqueda(userId, consulta, tipos ? tipos[0] : null, lugares.length);
    return { lugares };
  };

  let r = await buscar(RADIO_CORTO);
  if (r.tope) return r.tope;
  if (r.error) return 'No pude buscar en este momento. Intenta de nuevo en un rato.';
  let lugares = ordenar(origen, r.lugares);
  let radio = RADIO_CORTO;
  if (lugares.length < 3) {
    const r2 = await buscar(RADIO_LARGO);
    if (r2.lugares) { lugares = ordenar(origen, [...r.lugares, ...r2.lugares]); radio = RADIO_LARGO; }
  }
  if (!lugares.length) return `No encontré "${consulta}" cerca de ti (busqué hasta ${radio / 1000} km).`;
  return formatear(origen, consulta, lugares.slice(0, 3));
}

const PEDIR_UBICACION = consulta =>
  `📍 Para buscarte ${consulta ? consulta.toLowerCase() : 'eso'} necesito saber dónde estás. Compárteme tu ubicación: toca el clip 📎 → Ubicación → Enviar mi ubicación actual.`;

module.exports = {
  guardarUbicacionActual, ubicacionReciente, dejarPendiente, tomarPendiente,
  buscarCerca, enlaceRuta, PEDIR_UBICACION,
  // Para pruebas.
  ordenar, textoDistancia, textoHorario, metros
};
