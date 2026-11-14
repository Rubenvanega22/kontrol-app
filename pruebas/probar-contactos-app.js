// Pruebas de "Elegir de mis contactos" (Perfil → Mis contactos) — npm run probar-contactos-app
//
// Saca de index.html las funciones de verdad y las corre con el selector del teléfono
// (navigator.contacts.select), la pantalla y Supabase simulados:
//   1. Un número: llena el formulario, limpia el número y GUARDA solo.
//   2. Varios números: deja escoger (sin repetidos) y guarda el escogido.
//   3. Sin número, fijo, sin nombre, cancelado, error del selector, nombre repetido,
//      falla de red: no guarda y avisa.
//   4. Limpieza de números: espacios, guiones, +57, (+57), 0057, marcas invisibles.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function sacarFuncion(nombre) {
  const m = html.match(new RegExp(`(?:async\\s+)?function\\s+${nombre}\\s*\\(`));
  if (!m) throw new Error(`no está la función ${nombre}`);
  let i = html.indexOf('{', m.index + m[0].length);
  let nivel = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') nivel++;
    else if (html[j] === '}' && --nivel === 0) return html.slice(m.index, j + 1);
  }
  throw new Error(`función ${nombre} sin cerrar`);
}
const NOMBRES = ['normalizarTelefono', 'telefonoBonito', 'leerContactoElegido', 'elegirDeMisContactos',
  'pintarNumerosContacto', 'elegirNumeroContacto', 'limpiarNumerosContacto', 'guardarContacto'];
const codigo = `let numerosElegibles = []; let contactoEditId = null;\n${NOMBRES.map(sacarFuncion).join('\n')}\n` +
  `return { ${NOMBRES.join(', ')}, editar: id => { contactoEditId = id; } };`;

function montar({ elegidos, falla, errorBase, redCaida } = {}) {
  const els = {};
  const el = id => (els[id] = els[id] || { id, value: '', innerHTML: '', disabled: false, style: {} });
  const doc = { getElementById: el };
  const avisos = [], guardados = [], ocultos = [];
  const supa = {
    from: () => ({
      insert: async fila => { if (redCaida) throw new Error('Failed to fetch'); if (!errorBase) guardados.push({ op: 'insert', ...fila }); return { error: errorBase || null }; },
      update: fila => ({ eq: () => ({ eq: async () => { guardados.push({ op: 'update', ...fila }); return { error: null }; } }) })
    })
  };
  const nav = { contacts: { select: async (props, opts) => {
    assert.deepStrictEqual(props, ['name', 'tel']);
    assert.deepStrictEqual(opts, { multiple: false });
    if (falla) throw falla;
    return elegidos;
  } } };
  const f = new Function('document', 'navigator', 'supa', 'toast', 'hideModal', 'pintarContactos', 'sesionLista', 'escAttr', 'currentUser', 'console', codigo)(
    doc, nav, supa, (t, c) => avisos.push(t), id => ocultos.push(id), () => {}, async () => true,
    s => String(s).replace(/</g, '&lt;'), { id: 'u1' }, { warn() {}, log() {} });
  return { f, el, avisos, guardados, ocultos };
}

let fallas = 0;
async function caso(nombre, fn) {
  try { await fn(); console.log('  ✓', nombre); }
  catch (e) { fallas++; console.log('  ✗', nombre, '\n     ', e.message); }
}

(async () => {
  console.log('1. Un número: llena y guarda solo');
  await caso('George, +57 300-123-4567', async () => {
    const t = montar({ elegidos: [{ name: ['George'], tel: ['+57 300-123-4567'] }] });
    await t.f.elegirDeMisContactos();
    assert.strictEqual(t.el('contacto-nombre').value, 'George');
    assert.strictEqual(t.el('contacto-telefono').value, '300 123 4567');
    assert.deepStrictEqual(t.guardados, [{ op: 'insert', user_id: 'u1', nombre: 'George', telefono: '+573001234567' }]);
    assert.deepStrictEqual(t.ocultos, ['modal-contacto-form']);
    assert.strictEqual(t.avisos.at(-1), '✅ George guardado en tus contactos');
  });
  await caso('nombre con espacios de más y número con marcas invisibles de Android', async () => {
    const t = montar({ elegidos: [{ name: ['  George   Pérez '], tel: ['‪+57 300 123 4567‬'] }] });
    await t.f.elegirDeMisContactos();
    assert.strictEqual(t.guardados[0].nombre, 'George Pérez');
    assert.strictEqual(t.guardados[0].telefono, '+573001234567');
  });
  await caso('editando un contacto, actualiza en vez de crear', async () => {
    const t = montar({ elegidos: [{ name: ['George'], tel: ['3001234567'] }] });
    t.f.editar(7);
    await t.f.elegirDeMisContactos();
    assert.strictEqual(t.guardados[0].op, 'update');
    assert.strictEqual(t.avisos.at(-1), '✅ George actualizado');
  });

  console.log('2. Varios números: deja escoger');
  await caso('muestra los números sin repetir y guarda el escogido', async () => {
    const t = montar({ elegidos: [{ name: ['George'], tel: ['300 111 2222', '+57 300 111 2222', '310-555-6666', '601 234 5678'] }] });
    await t.f.elegirDeMisContactos();
    assert.strictEqual(t.guardados.length, 0, 'no debe guardar antes de escoger');
    const caja = t.el('contacto-numeros');
    assert.strictEqual(caja.style.display, '');
    assert.strictEqual((caja.innerHTML.match(/elegirNumeroContacto\(/g) || []).length, 2);
    assert.ok(caja.innerHTML.includes('300 111 2222') && caja.innerHTML.includes('310 555 6666'));
    await t.f.elegirNumeroContacto(1);
    assert.strictEqual(t.guardados[0].telefono, '+573105556666');
    assert.strictEqual(caja.style.display, 'none');
  });

  console.log('3. No guarda y avisa');
  const sinGuardar = [
    ['contacto sin número', { elegidos: [{ name: ['George'], tel: [] }] }, /no tiene número/],
    ['solo un fijo', { elegidos: [{ name: ['George'], tel: ['601 234 5678'] }] }, /no parece un celular/],
    ['contacto sin nombre', { elegidos: [{ name: [], tel: ['3001234567'] }] }, /no tiene nombre/],
    ['el selector falla', { falla: new Error('InvalidStateError') }, /No pude abrir tus contactos/],
    ['nombre repetido', { elegidos: [{ name: ['George'], tel: ['3001234567'] }], errorBase: { code: '23505', message: 'dup' } }, /Ya tienes un contacto llamado George/],
    ['sin conexión', { elegidos: [{ name: ['George'], tel: ['3001234567'] }], redCaida: true }, /Revisa tu conexión/],
  ];
  for (const [nombre, opciones, aviso] of sinGuardar) {
    await caso(nombre, async () => {
      const t = montar(opciones);
      await t.f.elegirDeMisContactos();
      assert.strictEqual(t.guardados.length, 0);
      assert.strictEqual(t.ocultos.length, 0, 'el formulario sigue abierto');
      assert.match(t.avisos.at(-1) || '', aviso);
      assert.strictEqual(t.el('contacto-guardar').disabled, false);
    });
  }
  await caso('canceló el selector: no hace nada', async () => {
    const t = montar({ elegidos: [] });
    await t.f.elegirDeMisContactos();
    assert.strictEqual(t.guardados.length + t.avisos.length, 0);
  });
  await caso('solo un fijo deja el número escrito para corregirlo', async () => {
    const t = montar({ elegidos: [{ name: ['George'], tel: ['601 234 5678'] }] });
    await t.f.elegirDeMisContactos();
    assert.strictEqual(t.el('contacto-telefono').value, '601 234 5678');
    assert.strictEqual(t.el('contacto-nombre').value, 'George');
  });

  console.log('4. Limpieza de números');
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
