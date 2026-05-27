// /lib/datetime.js — fechas en zona horaria Colombia (America/Bogota = UTC-5)
//
// Vercel runtime corre en UTC. Llamar a `new Date()` devuelve un timestamp
// absoluto correcto, pero los métodos como `.toISOString().split('T')[0]` o
// `.getFullYear()` interpretan en UTC, no en Colombia. Después de 7pm Col
// (medianoche UTC), eso provoca que el backend "vea" un día adelante,
// causando bugs como: "qué día es hoy" → 1 día desfasado, movimientos
// registrados con fecha equivocada, eventos filtrados por fecha errónea.
//
// Estos helpers siempre proyectan el timestamp en America/Bogota usando
// Intl.DateTimeFormat (robusto a DST si algún día se extiende a otros países;
// Colombia no observa DST hoy).

const TZ = 'America/Bogota';

// "YYYY-MM-DD" en hora Colombia.
// Usamos 'en-CA' porque ese locale devuelve el formato ISO de fecha.
function colombiaDateString(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: TZ });
}

// "miércoles, 27 de mayo de 2026" en hora Colombia.
// Pensado para mostrar al usuario y como contexto del system prompt de la IA.
function colombiaDateLongEs(date = new Date()) {
  return date.toLocaleDateString('es-CO', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: TZ
  });
}

// "20:49" 24h en hora Colombia. Para que la IA conozca la hora del día.
function colombiaTimeString(date = new Date()) {
  return date.toLocaleTimeString('es-CO', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: TZ
  });
}

// {anio, mes (0-11), dia (1-31)} en hora Colombia.
// Útil cuando se necesitan los componentes separados (ej. construir inicioMes,
// extraer año actual para tabla `metas`).
function colombiaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = t => parseInt(parts.find(p => p.type === t).value, 10);
  return { anio: get('year'), mes: get('month') - 1, dia: get('day') };
}

module.exports = { colombiaDateString, colombiaDateLongEs, colombiaTimeString, colombiaDateParts };
