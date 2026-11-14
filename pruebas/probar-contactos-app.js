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
const NOMBRES = ['normalizarTelefono', 'telefonoBonito', 'recordarTokenContactos', 'estadoContacto', 'avisoContacto',
  'esperarVisible', 'leerContactoElegido', 'elegirDeMisContactos', 'pintarNumerosContacto', 'elegirNumeroContacto',
  'limpiarNumerosContacto', 'escribirContacto', 'guardarContacto', 'abrirFormContacto', 'revisarSelectorInterrumpido'];
const codigo = [
  'const CONTACTO_LIMITE_MS = LIMITE;',
  linea(/const CONTACTO_ELIGIENDO = .*;/),
  'let tokenContactos = null; let numerosElegibles = []; let contactoEditId = null; let contactos = [];',
  'const PUEDE_ELEGIR_CONTACTO = true;',
  linea(/const conLimite = .*;/),
  ...NOMBRES.map(sacarFuncion),
  `return { ${NOMBRES.join(', ')}, editar: id => { contactoEditId = id; }, token: t => { tokenContactos = t; }, verToken: () => tokenContactos };`
].join('\n');

function montar({ elegidos, falla, sesion = 'token-bueno', rest = {}, cliente = 'ok', visible = true, limite = 80 } = {}) {
  const els = {};
  const el = id => (els[id] = els[id] || { id, value: '', innerHTML: '', textContent: '', disabled: false, style: {} });
  const oyentes = new Set();
  const doc = {
    visibilityState: visible ? 'visible' : 'hidden', getElementById: el,
    addEventListener: (ev, fn) => oyentes.add(fn), removeEventListener: (ev, fn) => oyentes.delete(fn)
  };
  const almacen = {};
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
    if (falla) throw falla;
    return elegidos;
  } } };
  const f = new Function('document', 'navigator', 'supa', 'fetch', 'sessionStorage', 'toast', 'hideModal', 'showModal',
    'pintarContactos', 'abrirContactos', 'escAttr', 'currentUser', 'SUPA_URL', 'SUPA_KEY', 'console', 'LIMITE', codigo)(
    doc, nav, supa, fetchFalso, sesionStorage, (t) => avisos.push(t), id => ocultos.push(id), id => abiertos.push(id), () => {},
    async () => { abiertos.push('modal-contactos'); }, s => String(s).replace(/</g, '&lt;'), { id: 'u1' },
    'https://x.supabase.co', 'anon', { warn() {}, log() {} }, limite);
  const volver = () => { doc.visibilityState = 'visible'; [...oyentes].forEach(fn => fn()); };
  return { f, el, avisos, guardados, ocultos, abiertos, restLlamadas, almacen, volver, doc };
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
    ['canceló el selector', { elegidos: [] }, /No elegiste ningún contacto/],
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
