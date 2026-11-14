// Pruebas de "Elegir de mis contactos" (Perfil → Mis contactos) — npm run probar-contactos-app
//
// Saca de index.html las funciones de verdad y las corre con el selector del teléfono
// (navigator.contacts.select), la pantalla, la base y la sesión de Supabase simulados:
//   1. Un número: llena el formulario, limpia el número y GUARDA solo, directo a la base.
//   2. Lo que pasa en Android: la app queda en segundo plano mientras se elige; se guarda
//      al volver. Si la librería de Supabase se queda colgada, no se espera para siempre:
//      se avisa en el formulario. Permiso vencido: se usa la librería.
//   3. Varios números: deja escoger (sin repetidos) y guarda el escogido.
//   4. Sin número, fijo, sin nombre, cancelado, selector que falla, nombre repetido: no
//      guarda y lo dice EN el formulario (además del aviso flotante).
//   5. Android cerró Kontrol mientras se elegía: al reabrir, vuelve al formulario y lo explica.
//   6. Limpieza de números: espacios, guiones, +57, (+57), 0057, marcas invisibles.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function sacarFuncion(nombre) {
  const m = html.match(new RegExp(`(?:async\\s+)?function\\s+${nombre}\\s*\\(`));
  if (!m) throw new Error(`no está la función ${nombre}`);
  let i = html.indexOf('{', m.index + m[0].length);
  // Parámetros con valores por defecto ({ x = 1 } = {}): el cuerpo empieza después del ")".
  const cierre = html.indexOf(')', m.index + m[0].length);
  const cabeza = html.slice(m.index, cierre);
  if (cabeza.includes('{')) {
    let nivel = 0, j = m.index + m[0].length - 1;
    for (; j < html.length; j++) { if (html[j] === '(') nivel++; else if (html[j] === ')' && --nivel === 0) break; }
    i = html.indexOf('{', j);
  }
  let nivel = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') nivel++;
    else if (html[j] === '}' && --nivel === 0) return html.slice(m.index, j + 1);
  }
  throw new Error(`función ${nombre} sin cerrar`);
}
const linea = re => { const m = html.match(re); if (!m) throw new Error('no está: ' + re); return m[0]; };
const NOMBRES = ['leerRegistroContactos', 'pintarRegistroContactos', 'registrarPasoContacto', 'borrarRegistroContactos', 'toqueFueraContacto', 'normalizarTelefono', 'telefonoBonito', 'recordarTokenContactos', 'estadoContacto', 'avisoContacto',
  'esperarVisible', 'leerContactoElegido', 'elegirDeMisContactos', 'pintarNumerosContacto', 'elegirNumeroContacto',
  'limpiarNumerosContacto', 'escribirContacto', 'guardarContacto', 'abrirFormContacto', 'revisarSelectorInterrumpido',
  'navegadorCorto', 'selectorNoSirve', 'usarContactoRecibido', 'decodificarVcard', 'leerVcards', 'tomarCompartido', 'revisarContactoCompartido'];
const codigo = [
  'const CONTACTO_LIMITE_MS = LIMITE;',
  linea(/const CONTACTO_ELIGIENDO = .*;/),
  'let tokenContactos = null; let numerosElegibles = []; let contactoEditId = null; let contactos = [];',
  'const PUEDE_ELEGIR_CONTACTO = true;',
  linea(/const conLimite = .*;/),
  linea(/const REGISTRO_CONTACTOS = .*;/),
  linea(/const ultimos4 = .*;/),
  'let selectorPendiente = false;',
  linea(/const SELECTOR_NO_SIRVE = .*;/),
  'const AL_INSTANTE_MS = INSTANTE;',
  linea(/const COMO_COMPARTIR = .*;/),
  linea(/const CACHE_COMPARTIDO = .*;/),
  linea(/const CLAVE_COMPARTIDO = .*;/),
  ...NOMBRES.map(sacarFuncion),
  `return { ${NOMBRES.join(', ')}, editar: id => { contactoEditId = id; }, token: t => { tokenContactos = t; }, verToken: () => tokenContactos };`
].join('\n');

function montar({ elegidos, falla, sesion = 'token-bueno', rest = {}, cliente = 'ok', visible = true, limite = 80, demora = 0, instante = 2500, compartido = null, url = '/' } = {}) {
  const els = {};
  const el = id => (els[id] = els[id] || { id, value: '', innerHTML: '', textContent: '', disabled: false, style: {} });
  const oyentes = new Set();
  const doc = {
    visibilityState: visible ? 'visible' : 'hidden', getElementById: el,
    addEventListener: (ev, fn) => oyentes.add(fn), removeEventListener: (ev, fn) => oyentes.delete(fn)
  };
  const almacen = {};
  const guardadoLocal = {};
  const local = { setItem: (k, v) => { guardadoLocal[k] = v; }, getItem: k => guardadoLocal[k] ?? null, removeItem: k => { delete guardadoLocal[k]; } };
  const sesionStorage = { setItem: (k, v) => { almacen[k] = v; }, getItem: k => almacen[k] ?? null, removeItem: k => { delete almacen[k]; } };
  const avisos = [], guardados = [], ocultos = [], abiertos = [];
  const restLlamadas = [];
  const fetchFalso = async (url, op) => {
    restLlamadas.push({ url, op });
    const st = rest.status || 201;
    guardados.push({ via: 'rest', metodo: op.method, ...JSON.parse(op.body) });
    if (st >= 400) guardados.pop();
    return { ok: st < 400, status: st, json: async () => rest.cuerpo || {} };
  };
  const nunca = new Promise(() => {});
  const supa = {
    auth: { getSession: () => Promise.resolve({ data: { session: sesion ? { access_token: sesion } : null } }) },
    from: () => ({
      insert: fila => { if (cliente === 'colgado') return nunca; guardados.push({ via: 'cliente', ...fila }); return Promise.resolve({ error: null }); },
      update: fila => ({ eq: () => ({ eq: () => { if (cliente === 'colgado') return nunca; guardados.push({ via: 'cliente', ...fila }); return Promise.resolve({ error: null }); } }) })
    })
  };
  const nav = { contacts: { select: async (props, opts) => {
    assert.deepStrictEqual(props, ['name', 'tel']);
    assert.deepStrictEqual(opts, { multiple: false });
    assert.ok(almacen.kontrol_eligiendo_contacto, 'marca "eligiendo" antes de abrir el selector');
    if (demora) await new Promise(r => setTimeout(r, demora));
    if (falla) throw falla;
    return elegidos;
  } }, userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0 Mobile Safari/537.36' };
  let enCache = compartido ? JSON.stringify(compartido) : null;
  const cachesFalso = { open: async () => ({ match: async () => (enCache ? { json: async () => JSON.parse(enCache) } : undefined), delete: async () => { enCache = null; return true; } }) };
  const ubicacion = { search: url.includes('?') ? url.slice(url.indexOf('?')) : '', pathname: '/' };
  const historial = { replaceState: (a, b, u) => { ubicacion.search = ''; } };
  const f = new Function('document', 'navigator', 'supa', 'fetch', 'sessionStorage', 'localStorage', 'APP_VERSION', 'toast', 'hideModal', 'showModal',
    'pintarContactos', 'abrirContactos', 'escAttr', 'currentUser', 'SUPA_URL', 'SUPA_KEY', 'console', 'LIMITE', 'INSTANTE', 'caches', 'location', 'history', 'window', 'matchMedia', 'TextDecoder', codigo)(
    doc, nav, supa, fetchFalso, sesionStorage, local, '1a2b3c4d5e6f7a8b', (t) => avisos.push(t), id => ocultos.push(id), id => abiertos.push(id), () => {},
    async () => { abiertos.push('modal-contactos'); }, s => String(s).replace(/</g, '&lt;'), { id: 'u1' },
    'https://x.supabase.co', 'anon', { warn() {}, log() {} }, limite, instante, cachesFalso, ubicacion, historial,
    { matchMedia: () => ({ matches: true }) }, () => ({ matches: true }), TextDecoder);
  const volver = () => { doc.visibilityState = 'visible'; [...oyentes].forEach(fn => fn()); };
  const registro = () => JSON.parse(guardadoLocal.kontrol_registro_contactos || '[]').map(l => l.replace(/^\S+ · /, ''));
  return { f, el, avisos, guardados, ocultos, abiertos, restLlamadas, almacen, volver, doc, registro, guardadoLocal, ubicacion, quedaEnCache: () => enCache };
}
const esperar = ms => new Promise(r => setTimeout(r, ms));
async function abrirYElegir(t) { t.f.abrirFormContacto(); await esperar(0); return t.f.elegirDeMisContactos(); }

let fallas = 0;
async function caso(nombre, fn) {
  try { await fn(); console.log('  ✓', nombre); }
  catch (e) { fallas++; console.log('  ✗', nombre, '\n     ', e.message); }
}

(async () => {
  console.log('1. Un número: llena y guarda solo, directo a la base');
  await caso('George, +57 300-123-4567', async () => {
    const t = montar({ elegidos: [{ name: ['George'], tel: ['+57 300-123-4567'] }] });
    await abrirYElegir(t);
    assert.strictEqual(t.el('contacto-nombre').value, 'George');
    assert.strictEqual(t.el('contacto-telefono').value, '300 123 4567');
    assert.deepStrictEqual(t.guardados, [{ via: 'rest', metodo: 'POST', user_id: 'u1', nombre: 'George', telefono: '+573001234567' }]);
    const h = t.restLlamadas[0].op.headers;
    assert.strictEqual(h.Authorization, 'Bearer token-bueno');
    assert.strictEqual(h.apikey, 'anon');
    assert.deepStrictEqual(t.ocultos, ['modal-contacto-form']);
    assert.strictEqual(t.avisos.at(-1), '✅ George guardado en tus contactos');
    assert.ok(!t.almacen.kontrol_eligiendo_contacto, 'quita la marca al volver');
  });
  await caso('nombre con espacios de más y número con marcas invisibles de Android', async () => {
    const t = montar({ elegidos: [{ name: ['  George   Pérez '], tel: ['‪+57 300 123 4567‬'] }] });
    await abrirYElegir(t);
    assert.strictEqual(t.guardados[0].nombre, 'George Pérez');
    assert.strictEqual(t.guardados[0].telefono, '+573001234567');
  });
  await caso('editando un contacto, actualiza (PATCH) en vez de crear', async () => {
    const t = montar({ elegidos: [{ name: ['George'], tel: ['3001234567'] }] });
    t.f.abrirFormContacto(); await esperar(0);
    t.f.editar(7);
    await t.f.elegirDeMisContactos();
    assert.strictEqual(t.guardados[0].metodo, 'PATCH');
    assert.match(t.restLlamadas[0].url, /contactos\?id=eq\.7&user_id=eq\.u1$/);
    assert.strictEqual(t.avisos.at(-1), '✅ George actualizado');
  });

  console.log('2. Lo que pasa en Android al volver del selector');
  await caso('la app sigue en segundo plano: espera a volver y entonces guarda', async () => {
    const t = montar({ elegidos: [{ name: ['George'], tel: ['3001234567'] }], visible: false });
    t.f.abrirFormContacto(); await esperar(0);
    const listo = t.f.elegirDeMisContactos();
    await esperar(20);
    assert.strictEqual(t.guardados.length, 0, 'no guarda mientras no se ve');
    assert.strictEqual(t.el('contacto-estado').textContent, 'Guardando a George…');
    t.volver();
    await listo;
    assert.strictEqual(t.guardados.length, 1);
  });
  await caso('sin permiso guardado y la librería colgada: avisa en el formulario, no se queda esperando', async () => {
    const t = montar({ elegidos: [{ name: ['George'], tel: ['3001234567'] }], sesion: null, cliente: 'colgado', limite: 60 });
    await abrirYElegir(t);
    assert.strictEqual(t.guardados.length, 0);
    assert.match(t.el('contacto-estado').textContent, /la conexión tardó demasiado\. Toca Guardar/);
    assert.strictEqual(t.el('contacto-estado').style.display, '');
    assert.strictEqual(t.el('contacto-guardar').disabled, false);
    assert.strictEqual(t.ocultos.length, 0, 'el formulario sigue abierto con los datos');
    assert.strictEqual(t.el('contacto-telefono').value, '300 123 4567');
  });
  await caso('permiso vencido (401): reintenta con la librería y guarda', async () => {
    const t = montar({ elegidos: [{ name: ['George'], tel: ['3001234567'] }], rest: { status: 401 } });
    await abrirYElegir(t);
    assert.deepStrictEqual(t.guardados.map(g => g.via), ['cliente']);
    assert.strictEqual(t.f.verToken(), null);
    assert.strictEqual(t.avisos.at(-1), '✅ George guardado en tus contactos');
  });

  console.log('3. Varios números: deja escoger');
  await caso('muestra los números sin repetir y guarda el escogido', async () => {
    const t = montar({ elegidos: [{ name: ['George'], tel: ['300 111 2222', '+57 300 111 2222', '310-555-6666', '601 234 5678'] }] });
    await abrirYElegir(t);
    assert.strictEqual(t.guardados.length, 0, 'no debe guardar antes de escoger');
    const caja = t.el('contacto-numeros');
    assert.strictEqual(caja.style.display, '');
    assert.strictEqual((caja.innerHTML.match(/elegirNumeroContacto\(/g) || []).length, 2);
    assert.ok(caja.innerHTML.includes('300 111 2222') && caja.innerHTML.includes('310 555 6666'));
    await t.f.elegirNumeroContacto(1);
    assert.strictEqual(t.guardados[0].telefono, '+573105556666');
    assert.strictEqual(caja.style.display, 'none');
  });

  console.log('4. No guarda y lo dice en el formulario');
  const sinGuardar = [
    ['contacto sin número', { elegidos: [{ name: ['George'], tel: [] }] }, /no tiene número/],
    ['solo un fijo', { elegidos: [{ name: ['George'], tel: ['601 234 5678'] }] }, /no parece un celular/],
    ['contacto sin nombre', { elegidos: [{ name: [], tel: ['3001234567'] }] }, /no tiene nombre/],
    ['el selector falla', { falla: new Error('InvalidStateError') }, /No pude abrir tus contactos/],
    ['nombre repetido', { elegidos: [{ name: ['George'], tel: ['3001234567'] }], rest: { status: 409, cuerpo: { code: '23505', message: 'duplicate' } } }, /Ya tienes un contacto llamado George/],
    ['canceló el selector (después de mirar la lista)', { elegidos: [], instante: 0 }, /No llegó ningún contacto desde tu teléfono/],
  ];
  for (const [nombre, opciones, aviso] of sinGuardar) {
    await caso(nombre, async () => {
      const t = montar(opciones);
      await abrirYElegir(t);
      assert.strictEqual(t.guardados.length, 0);
      assert.strictEqual(t.ocultos.length, 0, 'el formulario sigue abierto');
      assert.match(t.el('contacto-estado').textContent, aviso);
      assert.strictEqual(t.el('contacto-guardar').disabled, false);
    });
  }

  console.log('5. Android cerró Kontrol mientras se elegía');
  await caso('al reabrir: vuelve al formulario y explica qué pasó', async () => {
    const t = montar();
    t.almacen.kontrol_eligiendo_contacto = JSON.stringify({ at: Date.now() - 30000, id: null });
    t.f.revisarSelectorInterrumpido();
    await esperar(0);
    assert.deepStrictEqual(t.abiertos, ['modal-contactos', 'modal-contacto-form']);
    assert.match(t.el('contacto-estado').textContent, /Tu teléfono cerró Kontrol mientras elegías el contacto/);
    assert.ok(!t.almacen.kontrol_eligiendo_contacto);
  });
  await caso('una marca vieja (más de 5 min) no abre nada', async () => {
    const t = montar();
    t.almacen.kontrol_eligiendo_contacto = JSON.stringify({ at: Date.now() - 10 * 60 * 1000 });
    t.f.revisarSelectorInterrumpido();
    await esperar(0);
    assert.deepStrictEqual(t.abiertos, []);
  });

  console.log('5b. Registro paso a paso en pantalla');
  await caso('un guardado completo deja cada paso, con la versión y sin el número completo', async () => {
    const t = montar({ elegidos: [{ name: ['George'], tel: ['+57 300-123-4567'] }] });
    await abrirYElegir(t);
    assert.deepStrictEqual(t.registro(), [
      'Toqué "Elegir de mis contactos" (versión 1a2b3c4d, Samsung Internet 27 en Android, app instalada)',
      'Abriendo la lista del teléfono…',
      'La lista respondió: 1 contacto(s) · nombres: 1 · números: …4567',
      'Datos listos: George · …4567',
      'Guardando directo en la base…',
      '✅ Guardado: George'
    ]);
    assert.ok(!JSON.stringify(t.registro()).includes('3001234567'), 'no guarda el número completo');
    assert.match(t.el('contactos-registro').innerHTML, /Registro de "Elegir de mis contactos"/);
    assert.strictEqual(t.el('contactos-registro').style.display, '');
  });
  await caso('la lista no entrega nada (tras un rato): lo dice en pantalla y en el registro', async () => {
    const t = montar({ elegidos: [], instante: 0 });
    await abrirYElegir(t);
    assert.match(t.el('contacto-estado').textContent, /No llegó ningún contacto desde tu teléfono/);
    assert.match(t.avisos.at(-1), /No llegó ningún contacto/);
    assert.ok(t.registro().includes('La lista respondió: 0 contacto(s)'));
  });
  await caso('la lista devuelve algo raro (undefined): no se rompe y lo anota', async () => {
    const t = montar({ elegidos: undefined, instante: 0 });
    await abrirYElegir(t);
    assert.ok(t.registro().includes('La lista respondió algo inesperado: undefined'));
    assert.match(t.el('contacto-estado').textContent, /No llegó ningún contacto/);
  });
  await caso('la lista falla: anota el nombre del error', async () => {
    const e = new Error('Contacts Picker is already in use.'); e.name = 'InvalidStateError';
    const t = montar({ falla: e });
    await abrirYElegir(t);
    assert.ok(t.registro().includes('❌ La lista del teléfono falló: InvalidStateError — Contacts Picker is already in use.'));
    assert.match(t.el('contacto-estado').textContent, /InvalidStateError/);
  });
  await caso('un toque en el fondo NO cierra la ventana; se anota', async () => {
    const t = montar();
    t.f.toqueFueraContacto({ target: t.el('modal-contacto-form') });
    assert.strictEqual(t.ocultos.length, 0);
    assert.deepStrictEqual(t.registro(), ['Toque fuera de la ventana (no se cerró)']);
  });
  await caso('"Borrar registro" lo limpia', async () => {
    const t = montar({ elegidos: [] });
    await abrirYElegir(t);
    t.f.borrarRegistroContactos();
    assert.deepStrictEqual(t.registro(), []);
    assert.strictEqual(t.el('contactos-registro').style.display, 'none');
  });

  console.log('5c. La lista responde vacía al instante (Samsung, registro real del 14-nov-2026)');
  await caso('lo dice, explica Compartir, esconde el botón y lo recuerda en este celular', async () => {
    const t = montar({ elegidos: [] });
    await abrirYElegir(t);
    assert.match(t.el('contacto-estado').textContent, /Tu celular no le entrega el contacto a Kontrol.*Compartir y elige Kontrol/);
    assert.strictEqual(t.el('contacto-elegir').style.display, 'none');
    assert.strictEqual(t.guardadoLocal.kontrol_selector_no_sirve, '1');
    assert.ok(t.registro().some(l => /respondió vacía al instante \(\d+ ms\)/.test(l)));
    t.f.abrirFormContacto();
    assert.strictEqual(t.el('contacto-elegir').style.display, 'none', 'la próxima vez el botón ya no sale');
    assert.match(t.el('contacto-compartir-ayuda').textContent, /Compartir y elige Kontrol/);
    assert.strictEqual(t.el('contacto-compartir-ayuda').style.display, '');
  });
  await caso('si tarda (la persona miró y canceló) no se marca el celular', async () => {
    const t = montar({ elegidos: [], instante: 0, demora: 5 });
    await abrirYElegir(t);
    assert.strictEqual(t.guardadoLocal.kontrol_selector_no_sirve, undefined);
    assert.strictEqual(t.el('contacto-elegir').style.display, '');
  });

  console.log('5d. Leer un contacto compartido (.vcf)');
  const VCF_SAMSUNG = 'BEGIN:VCARD\r\nVERSION:2.1\r\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:P=C3=A9rez;Jos=C3=A9;;;\r\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jos=C3=A9 P=C3=A9r=\r\nez\r\nTEL;CELL:300 123 4567\r\nTEL;HOME:601 234 5678\r\nEND:VCARD\r\n';
  const VCF_GOOGLE = 'BEGIN:VCARD\nVERSION:3.0\nFN:George\nN:;George;;;\nitem1.TEL;TYPE=HOME:+57 601 234 5678\nitem2.TEL;TYPE=CELL:+57 310-555-6666\nPHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD=\n  AAAA==\nEND:VCARD\n';
  const VCF_IPHONE = 'BEGIN:VCARD\nVERSION:4.0\nFN:Paola\\, la vecina\nTEL;VALUE=uri;TYPE=cell:tel:+573001112222\nEND:VCARD';
  await caso('Samsung: nombre con tilde en quoted-printable y doblado, celular primero', async () => {
    const { leerVcards } = montar().f;
    assert.deepStrictEqual(leerVcards(VCF_SAMSUNG), [{ nombre: 'José Pérez', tels: ['300 123 4567', '601 234 5678'] }]);
  });
  await caso('Google: item1.TEL, foto con "=" no se come el número', async () => {
    const { leerVcards } = montar().f;
    assert.deepStrictEqual(leerVcards(VCF_GOOGLE), [{ nombre: 'George', tels: ['+57 310-555-6666', '+57 601 234 5678'] }]);
  });
  await caso('iPhone/vCard 4: "tel:" y coma escapada', async () => {
    const { leerVcards } = montar().f;
    assert.deepStrictEqual(leerVcards(VCF_IPHONE), [{ nombre: 'Paola, la vecina', tels: ['+573001112222'] }]);
  });
  await caso('texto que no es un contacto', async () => {
    assert.deepStrictEqual(montar().f.leerVcards('hola, mira esto'), []);
  });

  console.log('5e. Compartir → Kontrol');
  await caso('un contacto con un celular: se guarda solo y se borra lo compartido', async () => {
    const t = montar({ url: '/?compartido=1', compartido: { textos: [VCF_SAMSUNG], at: Date.now() } });
    await t.f.revisarContactoCompartido();
    assert.deepStrictEqual(t.guardados, [{ via: 'rest', metodo: 'POST', user_id: 'u1', nombre: 'José Pérez', telefono: '+573001234567' }]);
    assert.strictEqual(t.avisos.at(-1), '✅ José Pérez guardado en tus contactos');
    assert.strictEqual(t.quedaEnCache(), null);
    assert.strictEqual(t.ubicacion.search, '', 'quita ?compartido de la dirección');
    assert.ok(t.registro()[0].startsWith('Llegó algo compartido a Kontrol'));
  });
  await caso('un contacto con dos celulares: deja escoger', async () => {
    const dos = 'BEGIN:VCARD\nFN:Ana\nTEL;CELL:3001111111\nTEL;CELL:3102222222\nEND:VCARD';
    const t = montar({ url: '/?compartido=1', compartido: { textos: [dos] } });
    await t.f.revisarContactoCompartido();
    assert.strictEqual(t.guardados.length, 0);
    assert.strictEqual((t.el('contacto-numeros').innerHTML.match(/elegirNumeroContacto\(/g) || []).length, 2);
    await t.f.elegirNumeroContacto(1);
    assert.strictEqual(t.guardados[0].telefono, '+573102222222');
  });
  await caso('varios contactos a la vez: guarda los claros y dice cuáles hacer a mano', async () => {
    const varios = VCF_SAMSUNG + VCF_IPHONE + 'BEGIN:VCARD\nFN:Sin Número\nEND:VCARD';
    const t = montar({ url: '/?compartido=1', compartido: { textos: [varios] } });
    await t.f.revisarContactoCompartido();
    assert.deepStrictEqual(t.guardados.map(g => g.nombre), ['José Pérez', 'Paola, la vecina']);
    assert.match(t.el('contacto-estado').textContent, /Guardé 2: José Pérez, Paola, la vecina\. ⚠️ Agrega a mano: Sin Número\./);
  });
  await caso('lo compartido no es un contacto: lo explica', async () => {
    const t = montar({ url: '/?compartido=1', compartido: { textos: ['https://algo.com'] } });
    await t.f.revisarContactoCompartido();
    assert.strictEqual(t.guardados.length, 0);
    assert.match(t.el('contacto-estado').textContent, /no trae un contacto/);
  });
  await caso('Kontrol no alcanzó a recibirlo (sin service worker): pide compartir otra vez', async () => {
    const t = montar({ url: '/?compartido=sin-sw' });
    await t.f.revisarContactoCompartido();
    assert.match(t.el('contacto-estado').textContent, /vuelve a compartirlo/);
  });
  await caso('sin ?compartido no hace nada', async () => {
    const t = montar({ compartido: { textos: [VCF_SAMSUNG] } });
    await t.f.revisarContactoCompartido();
    assert.strictEqual(t.abiertos.length + t.guardados.length, 0);
  });

  console.log('6. Limpieza de números');
  await caso('formatos', () => {
    const { normalizarTelefono: n } = montar().f;
    const lib = require('../lib/mensaje-programado').normalizarTelefono;
    const tabla = [
      ['300 123 4567', '+573001234567'], ['300-123-4567', '+573001234567'], ['(300) 123 4567', '+573001234567'],
      ['+57 300 123 4567', '+573001234567'], ['(+57) 300 123 4567', '+573001234567'], ['0057 300 123 4567', '+573001234567'],
      ['573001234567', '+573001234567'], ['+1 (555) 123-4567', '+15551234567'], ['‪+57 300 123 4567‬', '+573001234567'],
      ['601 234 5678', null], ['12345', null], ['', null]
    ];
    for (const [entra, sale] of tabla) {
      assert.strictEqual(n(entra), sale, `app: ${JSON.stringify(entra)}`);
      assert.strictEqual(lib(entra), sale, `bot: ${JSON.stringify(entra)}`);
    }
  });

  console.log(fallas ? `\n${fallas} prueba(s) fallaron` : '\nTodo bien');
  process.exit(fallas ? 1 : 0);
})();
