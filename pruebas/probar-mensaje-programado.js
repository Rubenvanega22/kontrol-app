// Pruebas de mensajes programados — se ejecuta con: npm run probar-mensaje-programado
//
// NO llama a Twilio ni a la base: Supabase va simulado en memoria.
//   1. detectarMensajeProgramado: a quién, qué mensaje y lo dicho fuera del mensaje.
//   2. Frases que NO son mensajes programados.
//   3. horaDelTexto + resolverMomento con la hora fija (sáb 14-nov-2026, 3:00 pm Colombia).
//   4. Teléfonos y enlace wa.me.
//   5. La conversación completa: pide el número una sola vez, pregunta lo que falta,
//      crea el evento tipo 'mensaje', devuelve el estado anterior, y la regla de Ana.

const assert = require('assert');
const path = require('path');

// ─── Supabase simulado en memoria (antes de cargar el flujo) ──────
const tablas = { contactos: [], events: [], whatsapp_state: [] };
let siguienteId = 1;
function consulta(tabla) {
  const filtros = [];
  let op = 'select', datos = null, unico = false, conflicto = null;
  const filas = () => tablas[tabla].filter(f => filtros.every(fn => fn(f)));
  const ejecutar = () => {
    if (op === 'insert') {
      const nuevas = (Array.isArray(datos) ? datos : [datos]).map(d => ({ id: siguienteId++, ...d }));
      for (const n of nuevas) {
        if (tabla === 'contactos' && tablas.contactos.some(c => c.user_id === n.user_id && c.nombre.toLowerCase() === n.nombre.toLowerCase())) {
          return { data: null, error: { code: '23505', message: 'duplicado' } };
        }
      }
      tablas[tabla].push(...nuevas);
      return { data: unico ? nuevas[0] : nuevas, error: null };
    }
    if (op === 'upsert') {
      const i = tablas[tabla].findIndex(f => f[conflicto] === datos[conflicto]);
      if (i >= 0) tablas[tabla][i] = { ...datos }; else tablas[tabla].push({ ...datos });
      return { data: null, error: null };
    }
    if (op === 'update') {
      const af = filas();
      af.forEach(f => Object.assign(f, datos));
      return { data: af, error: null };
    }
    if (op === 'delete') {
      const af = filas();
      tablas[tabla] = tablas[tabla].filter(f => !af.includes(f));
      return { data: af, error: null };
    }
    const r = filas();
    return { data: unico ? (r[0] || null) : r, error: null };
  };
  const q = {
    select() { return q; },
    insert(d) { op = 'insert'; datos = d; return q; },
    upsert(d, o) { op = 'upsert'; datos = d; conflicto = o.onConflict; return q; },
    update(d) { op = 'update'; datos = d; return q; },
    delete() { op = 'delete'; return q; },
    eq(c, v) { filtros.push(f => f[c] === v); return q; },
    ilike(c, v) { filtros.push(f => String(f[c]).toLowerCase() === String(v).toLowerCase()); return q; },
    order() { return q; },
    single() { unico = true; return q; },
    maybeSingle() { unico = true; return q; },
    then(ok, mal) { return Promise.resolve(ejecutar()).then(ok, mal); }
  };
  return q;
}
require.cache[path.resolve(__dirname, '../lib/supabase.js')] = {
  id: 'supabase', filename: 'supabase', loaded: true, exports: { from: consulta }
};

const M = require('../lib/mensaje-programado');
const F = require('../lib/mensaje-programado-flujo');

let fallas = 0;
async function caso(nombre, fn) {
  try { await fn(); console.log('  ✓', nombre); }
  catch (e) { fallas++; console.log('  ✗', nombre, '\n     ', e.message); }
}

const AHORA = new Date('2026-11-14T15:00:00-05:00'); // sábado 3:00 pm
const HOY = '2026-11-14';

(async () => {
  console.log('1. Detectar el pedido');
  const detectar = [
    ['a las 6:05 escríbele a Paola: ya voy en camino', 'Paola', 'Ya voy en camino'],
    ['A las 6:05 escríbele a Paola, ya voy en camino.', 'Paola', 'Ya voy en camino'],
    ['dile a Paola que ya voy', 'Paola', 'Ya voy'],
    ['Escríbele a Juan Pérez a las 3 pm diciéndole que llego tarde', 'Juan Pérez', 'Llego tarde'],
    ['mándale un mensaje a mi mamá mañana a las 8 que la llamo luego', 'Mamá', 'La llamo luego'],
    ['recuérdame escribirle a Carlos a las 7 de la noche: feliz cumpleaños', 'Carlos', 'Feliz cumpleaños'],
    ['escribele a paola el viernes a las 9 y media que nos vemos', 'Paola', 'Nos vemos'],
    ['escríbele a Paola', 'Paola', ''],
  ];
  for (const [frase, nombre, texto] of detectar) {
    await caso(frase, () => {
      const d = M.detectarMensajeProgramado(frase);
      assert.ok(d, 'no lo detectó');
      assert.strictEqual(d.nombre, nombre);
      assert.strictEqual(d.texto, texto);
    });
  }

  console.log('2. Frases que no son mensajes programados');
  for (const frase of ['qué día es hoy', 'agéndame una cita mañana a las 3', 'ya pagué la luz', 'búscame una droguería cerca', 'escribe en la lista de mercado leche']) {
    await caso(frase, () => assert.strictEqual(M.detectarMensajeProgramado(frase), null));
  }

  console.log('3. Hora y día en Colombia (ahora: sáb 14-nov 3:00 pm)');
  const momento = frase => {
    const d = M.detectarMensajeProgramado(frase);
    return M.resolverMomento(M.horaDelTexto(d.control), M.fechaDelTexto(d.control, HOY), AHORA);
  };
  const horas = [
    ['a las 6:05 escríbele a Paola: hola', { fecha: HOY, hora: '18:05' }],          // sin am/pm: la próxima
    ['a las 6:05 am escríbele a Paola: hola', { pregunta: 'manana', fecha: '2026-11-15', hora: '06:05' }],
    ['a las 2 pm escríbele a Paola: hola', { pregunta: 'manana', fecha: '2026-11-15', hora: '14:00' }],
    ['a las 18:30 escríbele a Paola: hola', { fecha: HOY, hora: '18:30' }],
    ['en 20 minutos escríbele a Pedro que ya salí', { fecha: HOY, hora: '15:20' }],
    ['a las seis y cinco de la tarde mándale a Paola ya voy', { fecha: HOY, hora: '18:05' }],
    ['mañana a las 8 escríbele a Paola: hola', { pregunta: 'ampm', h: 8, m: 0, fecha: '2026-11-15' }],
    ['mañana a las 8 pm escríbele a Paola: hola', { fecha: '2026-11-15', hora: '20:00' }],
    ['escríbele a Paola el viernes a las 9 de la mañana: hola', { fecha: '2026-11-20', hora: '09:00' }],
    ['ahora escríbele a Paola: ya llegué', { ahora: true }],
    ['escríbele a Paola: hola', { pregunta: 'hora' }],
    ['al mediodía escríbele a Paola: almorcemos', { pregunta: 'manana', fecha: '2026-11-15', hora: '12:00' }],
  ];
  for (const [frase, esperado] of horas) await caso(frase, () => assert.deepStrictEqual(momento(frase), esperado));
  await caso('"dile a Paola que llego a las 8": la hora del mensaje no cuenta', () => {
    const d = M.detectarMensajeProgramado('dile a Paola que llego a las 8');
    assert.strictEqual(M.horaDelTexto(d.control), null);
    assert.strictEqual(d.texto, 'Llego a las 8');
  });

  console.log('4. Teléfonos y enlace');
  await caso('teléfonos', () => {
    assert.strictEqual(M.normalizarTelefono('300 123 4567'), '+573001234567');
    assert.strictEqual(M.normalizarTelefono('es el 300-123-4567'), '+573001234567');
    assert.strictEqual(M.normalizarTelefono('+57 300 123 4567'), '+573001234567');
    assert.strictEqual(M.normalizarTelefono('573001234567'), '+573001234567');
    assert.strictEqual(M.normalizarTelefono('+1 (555) 123-4567'), '+15551234567');
    assert.strictEqual(M.normalizarTelefono('12345'), null);
    assert.strictEqual(M.normalizarTelefono('6012345678'), null); // fijo sin +: no es WhatsApp seguro
  });
  await caso('enlace wa.me con el mensaje codificado', () => {
    assert.strictEqual(M.enlaceWa('+573001234567', 'ya voy en camino ¿sí?'),
      'https://wa.me/573001234567?text=ya%20voy%20en%20camino%20%C2%BFs%C3%AD%3F');
  });

  console.log('5. La conversación');
  const U = 'user-1', TEL = '+573000000000';
  const estado = () => tablas.whatsapp_state.find(s => s.phone === TEL) || null;
  const responder = t => F.responderMensajeProgramado(U, TEL, t, estado());

  await caso('sin el número: lo pide, lo guarda y crea el evento', async () => {
    let r = await F.iniciarMensajeProgramado(U, TEL, 'a las 11:30 pm escríbele a Paola: ya voy en camino', null);
    assert.match(r, /No tengo el número de Paola/);
    assert.strictEqual(estado().awaiting, F.ESPERA);
    r = await responder('300 123 4567');
    assert.match(r, /Guardé a Paola en tus contactos/);
    assert.match(r, /11:30 pm te aviso para escribirle a Paola/);
    assert.strictEqual(tablas.contactos.length, 1);
    assert.strictEqual(tablas.contactos[0].telefono, '+573001234567');
    const ev = tablas.events[0];
    assert.strictEqual(ev.tipo, 'mensaje');
    assert.strictEqual(ev.titulo, 'Mensaje a Paola');
    assert.strictEqual(ev.nota, 'Ya voy en camino');
    assert.strictEqual(ev.hora, '23:30');
    assert.strictEqual(ev.contacto_id, tablas.contactos[0].id);
    assert.strictEqual(estado(), null);
  });

  await caso('con el número guardado no lo vuelve a pedir; pregunta el mensaje y la hora', async () => {
    let r = await F.iniciarMensajeProgramado(U, TEL, 'escríbele a paola', null);
    assert.strictEqual(r, '¿Qué le digo a Paola?');
    r = await responder('que ya salí');
    assert.match(r, /A qué hora/);
    r = await responder('mañana a las 7');
    assert.strictEqual(r, '¿7:00 de la mañana o de la tarde?');
    r = await responder('de la noche');
    assert.match(r, /Mañana a las 7:00 pm/);
    assert.strictEqual(tablas.contactos.length, 1);
    assert.strictEqual(tablas.events.length, 2);
  });

  await caso('varios contactos parecidos: pregunta a cuál', async () => {
    tablas.contactos.push({ id: siguienteId++, user_id: U, nombre: 'Paola Ruiz', telefono: '+573110000000' });
    tablas.contactos.push({ id: siguienteId++, user_id: U, nombre: 'Juan Gómez', telefono: '+573120000000' });
    tablas.contactos.push({ id: siguienteId++, user_id: U, nombre: 'Juan Pérez', telefono: '+573130000000' });
    let r = await F.iniciarMensajeProgramado(U, TEL, 'a las 10 pm escríbele a Juan: hola', null);
    assert.match(r, /varios contactos con "Juan"/);
    r = await responder('2');
    assert.match(r, /escribirle a Juan Pérez/);
  });

  await caso('"cancelar" no programa nada', async () => {
    await F.iniciarMensajeProgramado(U, TEL, 'escríbele a Paola: hola', null);
    const r = await responder('cancelar');
    assert.strictEqual(r, '👍 Listo, no programé nada.');
    assert.strictEqual(estado(), null);
  });

  await caso('una respuesta que no es para el flujo lo cierra y devuelve la factura pendiente', async () => {
    const factura = { phone: TEL, user_id: U, awaiting: 'factura_confirmar', context: { nombre: 'Luz' }, expires_at: new Date(Date.now() + 3600e3).toISOString() };
    tablas.whatsapp_state.push({ ...factura });
    await F.iniciarMensajeProgramado(U, TEL, 'escríbele a Paola', factura);
    assert.strictEqual(estado().awaiting, F.ESPERA);
    // Pregunta "¿Qué le digo?": cualquier texto es el mensaje. Luego la hora: "ya pagué la luz" no lo es.
    await responder('voy tarde');
    const r = await responder('ya pagué la luz');
    assert.strictEqual(r, null);
    assert.strictEqual(estado().awaiting, 'factura_confirmar');
    tablas.whatsapp_state.length = 0;
  });

  await caso('"ahora": responde de una con el enlace, sin crear evento', async () => {
    const antes = tablas.events.length;
    const r = await F.iniciarMensajeProgramado(U, TEL, 'ahora escríbele a Paola: ya llegué', null);
    assert.match(r, /https:\/\/wa\.me\/573001234567\?text=Ya%20llegu%C3%A9/);
    assert.strictEqual(tablas.events.length, antes);
  });

  await caso('"dile a Ana…" sin contacto Ana va a la asistente', async () => {
    assert.strictEqual(await F.iniciarMensajeProgramado(U, TEL, 'dile a Ana que me recuerde comprar pan', null), null);
  });

  await caso('"dile a Ana…" con un contacto Ana sí es mensaje programado', async () => {
    tablas.contactos.push({ id: siguienteId++, user_id: U, nombre: 'Ana', telefono: '+573140000000' });
    const r = await F.iniciarMensajeProgramado(U, TEL, 'a las 9 pm dile a Ana que ya llegué', null);
    assert.match(r, /escribirle a Ana/);
  });

  console.log('6. Cada persona lo pide distinto (prueba real fallida del 14-nov-2026)');
  // [frase, nombre, texto, hora esperada a las 3:00 pm o null si se pregunta]
  const variantes = [
    // Las que fallaron de verdad (audio transcrito por Whisper):
    ['escríbele un mensaje a Johanny a las 3 y 5', 'Johanny', '', '15:05'],
    ['Escribe a Johanny a las 3 y 5. Hola, por favor.', 'Johanny', 'Hola, por favor', '15:05'],
    ['Mándale este mensaje a... ...Johanny a las 3 de la tarde de hoy. Hola.', 'Johanny', 'Hola', '15:00'],
    ['Quiero que le escribas a Rubén a su WhatsApp hola.', 'Rubén', 'Hola', null],
    // Variantes:
    ['Mándale un WhatsApp a Johanny a las 3 y 5: ya voy', 'Johanny', 'Ya voy', '15:05'],
    ['envíale un mensaje a Johanny que ya salí, a las 4 pm', 'Johanny', 'Ya salí', '16:00'],
    ['avísale a Johanny a las 3 y 5 que llego tarde', 'Johanny', 'Llego tarde', '15:05'],
    ['a las 3 y 5 mándale a Johanny: hola', 'Johanny', 'Hola', '15:05'],
    ['envíame un mensaje a Johanny a las 3 y 5 diciendo que ya voy', 'Johanny', 'Ya voy', '15:05'],
    ['Necesito que le mandes un mensaje a Johanny hoy a las 3 y 5 que ya llegué', 'Johanny', 'Ya llegué', '15:05'],
    ['dile a Johanny a las 3 y 5 que ya voy', 'Johanny', 'Ya voy', '15:05'],
    ['Envíale un WhatsApp a Johanny en 20 minutos: voy en camino', 'Johanny', 'Voy en camino', '15:20'],
    ['recuérdame escribirle a Johanny a las 3 y 5: feliz día', 'Johanny', 'Feliz día', '15:05'],
    ['Escríbele a Johanny Pérez, a las 3 y 5, que ya voy', 'Johanny Pérez', 'Ya voy', '15:05'],
    ['puedes escribirle a Johanny a las cinco de la tarde que ya voy', 'Johanny', 'Ya voy', '17:00'],
  ];
  for (const [frase, nombre, texto, hora] of variantes) {
    await caso(frase, () => {
      const d = M.detectarMensajeProgramado(frase);
      assert.ok(d, 'no lo detectó');
      assert.strictEqual(d.nombre, nombre);
      assert.strictEqual(d.texto, texto);
      const r = M.resolverMomento(M.horaDelTexto(d.control), M.fechaDelTexto(d.control, HOY), AHORA);
      if (hora) assert.deepStrictEqual(r, { fecha: HOY, hora });
      else assert.deepStrictEqual(r, { pregunta: 'hora' });
    });
  }
  await caso('"dile a Paola que llego a las 8": sin coma, la hora es del mensaje', () => {
    assert.strictEqual(M.detectarMensajeProgramado('dile a Paola que llego a las 8').texto, 'Llego a las 8');
  });
  for (const frase of ['escribe en la lista de mercado leche', 'manda a la lista de mercado pan', 'avísame mañana a las 8']) {
    await caso(`no es mensaje: "${frase}"`, () => {
      const d = M.detectarMensajeProgramado(frase);
      assert.ok(!d || !d.nombre);
    });
  }

  console.log('7. ¿Se le pregunta a Haiku? (habla de escribirle algo a alguien)');
  for (const [frase, si] of [
    ['Johanny tiene que saber que ya voy, avísale a las 3 y 5', true],
    ['a Johanny le escribes a las 3 y 5 que ya voy', true],
    ['envíame un mensaje a Johanny', true],
    ['dile a mi mamá que ya voy', true],
    ['avísame mañana a las 8', false],
    ['mándame el resumen de pagos', false],
    ['quiero mandar a arreglar el carro', false],
    ['recuérdame comprar pan', false],
    ['¿puedes mandar mensajes?', false],
    ['agenda cita con el dentista mañana a las 3', false],
  ]) {
    await caso(`${si ? 'sí' : 'no'}: "${frase}"`, () => assert.strictEqual(M.mencionaMensajeAOtro(frase), si));
  }

  console.log('8. Lo que responde Haiku (solo vale lo que dijo el usuario)');
  const MSG = 'Johanny tiene que saber que ya voy, avísale a las 3 y 5';
  await caso('respuesta normal', () => {
    assert.deepStrictEqual(F.interpretarMensajeIA('{"es_mensaje":true,"nombre":"Johanny","texto":"que ya voy","cuando":"a las 3 y 5"}', MSG),
      { nombre: 'Johanny', texto: 'Que ya voy', control: 'a las 3 y 5' });
  });
  await caso('un nombre o una hora que no dijo se descartan', () => {
    assert.deepStrictEqual(F.interpretarMensajeIA('{"es_mensaje":true,"nombre":"Juliana","texto":"ya voy","cuando":"a las 15:05"}', MSG),
      { nombre: '', texto: 'Ya voy', control: '' });
  });
  await caso('no es mensaje, o respuesta rara', () => {
    assert.strictEqual(F.interpretarMensajeIA('{"es_mensaje":false}', MSG), null);
    assert.strictEqual(F.interpretarMensajeIA('no sé', MSG), null);
  });
  await caso('con markdown alrededor', () => {
    assert.strictEqual(F.interpretarMensajeIA('```json\n{"es_mensaje":true,"nombre":"a Johanny","texto":"","cuando":""}\n```', MSG).nombre, 'Johanny');
  });

  console.log('9. Lo que entendió Haiku arranca la misma conversación');
  await caso('con nombre y hora de Haiku: guarda el mensaje', async () => {
    tablas.whatsapp_state.length = 0;
    const antes = tablas.events.length;
    const r = await F.iniciarMensajeProgramado(U, TEL, MSG, null, { detectado: { nombre: 'Paola', texto: 'Ya voy', control: 'a las 11:50 pm' } });
    assert.match(r, /11:50 pm te aviso para escribirle a Paola/);
    assert.strictEqual(tablas.events.length, antes + 1);
  });
  await caso('sin nombre: pregunta "¿A quién le escribo?" y sigue', async () => {
    let r = await F.iniciarMensajeProgramado(U, TEL, 'mensaje', null, { detectado: { nombre: '', texto: 'Ya voy', control: 'a las 11:40 pm' } });
    assert.strictEqual(r, '¿A quién le escribo?');
    r = await responder('a Paola');
    assert.match(r, /11:40 pm te aviso para escribirle a Paola/);
  });
  await caso('"3 y 5" como respuesta a "¿A qué hora?"', async () => {
    let r = await F.iniciarMensajeProgramado(U, TEL, 'escríbele a Paola: hola', null);
    assert.match(r, /A qué hora/);
    r = await responder('11 y 5 de la noche');
    assert.match(r, /11:05 pm te aviso para escribirle a Paola/);
  });

  console.log('10. "No puedo enviar mensajes" de la asistente se reconoce');
  for (const [texto, si] of [
    ['No puedo enviar mensajes a otras personas. Solo gestiono tu agenda.', true],
    ['No puedo escribir mensajes de WhatsApp ni contactar a otras personas.', true],
    ['No envío mensajes, pero puedo agendarte un recordatorio.', true],
    ['✅ Listo, agendé tu cita.', false],
    ['No puedo borrar ese pago.', false],
  ]) {
    await caso(`${si ? 'sí' : 'no'}: "${texto}"`, () => assert.strictEqual(F.niegaEnviarMensajes(texto), si));
  }

  console.log('11. Nombres mal entendidos en un audio: "¿Te refieres a…?"');
  const guardados = ['Johanny', 'Paola Gómez', 'Juan Pérez', 'Carlos', 'Jorge', 'Valentina'].map((nombre, id) => ({ id, nombre }));
  for (const [dicho, esperado] of [
    ['Yohany', ['Johanny']], ['Jhoany', ['Johanny']], ['Yojani', ['Johanny']], ['Johnny', ['Johanny']],
    ['Karlos', ['Carlos']], ['Jorje', ['Jorge']], ['Paula', ['Paola Gómez']], ['Valentín', ['Valentina']],
    ['Pedro', []], ['Sofía', []], ['Yúlzale', []], ['Al', []],
  ]) {
    await caso(`"${dicho}" → ${esperado.join(', ') || 'ninguno'}`, () => {
      assert.deepStrictEqual(M.contactosParecidos(guardados, dicho).map(c => c.nombre), esperado);
    });
  }
  const JOHANNY = { id: siguienteId++, user_id: U, nombre: 'Johanny', telefono: '+573150000000' };
  tablas.contactos.push(JOHANNY);
  await caso('"Yohany" → "¿Te refieres a Johanny?" → sí → mensaje a Johanny, sin pedir número', async () => {
    tablas.whatsapp_state.length = 0;
    const antes = tablas.contactos.length;
    let r = await F.iniciarMensajeProgramado(U, TEL, 'a las 11:57 pm escríbele a Yohany: ya voy', null);
    assert.strictEqual(r, '¿Te refieres a Johanny? Responde sí, o no si es otra persona.');
    r = await responder('sí');
    assert.match(r, /11:57 pm te aviso para escribirle a Johanny/);
    assert.strictEqual(tablas.events.at(-1).contacto_id, JOHANNY.id);
    assert.strictEqual(tablas.contactos.length, antes, 'no crea un contacto nuevo');
  });
  await caso('"no" quiere decir otra persona: pide el número de Yohany (no cancela)', async () => {
    await F.iniciarMensajeProgramado(U, TEL, 'a las 11:57 pm escríbele a Yohany: ya voy', null);
    const r = await responder('no');
    assert.strictEqual(r, 'No tengo el número de Yohany. ¿Cuál es? Por ejemplo: 300 123 4567');
  });
  await caso('también si el nombre llega después ("¿A quién le escribo?")', async () => {
    let r = await F.iniciarMensajeProgramado(U, TEL, 'x', null, { detectado: { nombre: '', texto: 'Hola', control: 'a las 11:56 pm' } });
    assert.strictEqual(r, '¿A quién le escribo?');
    r = await responder('Jhoany');
    assert.match(r, /¿Te refieres a Johanny\?/);
    r = await responder('1');
    assert.match(r, /escribirle a Johanny/);
  });
  await caso('varios parecidos: se escoge con el número', async () => {
    tablas.contactos.push({ id: siguienteId++, user_id: U, nombre: 'Johana', telefono: '+573160000000' });
    let r = await F.iniciarMensajeProgramado(U, TEL, 'a las 11:55 pm escríbele a Yohanna: hola', null);
    assert.match(r, /¿Te refieres a alguno de estos\?\n1\. Joh/);
    assert.ok(r.includes('Johanny') && r.includes('Johana'));
    r = await responder('cancelar');
    assert.strictEqual(r, '👍 Listo, no programé nada.');
  });

  console.log(fallas ? `\n${fallas} prueba(s) fallaron` : '\nTodo bien');
  process.exit(fallas ? 1 : 0);
})();
