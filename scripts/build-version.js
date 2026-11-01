// Corre en cada deploy de Vercel. Calcula la versión con el contenido de index.html,
// la escribe en la página y en version.json. Así la app compara lo que está corriendo
// con lo publicado, y un deploy que solo toca el backend no recarga a nadie.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// En local no hace nada: no debe modificar index.html en el repositorio.
if (!process.env.VERCEL) {
  console.log('[build-version] fuera de Vercel, sin cambios');
  process.exit(0);
}

const raiz = path.join(__dirname, '..');
const archivo = path.join(raiz, 'index.html');
const html = fs.readFileSync(archivo, 'utf8');
const MARCA = '__KONTROL_VERSION__';
if (!html.includes(MARCA)) throw new Error('index.html no tiene la marca de versión');

const version = crypto.createHash('sha256').update(html).digest('hex').slice(0, 16);
fs.writeFileSync(archivo, html.split(MARCA).join(version));
fs.writeFileSync(path.join(raiz, 'version.json'), JSON.stringify({ version }));
console.log('[build-version] versión', version);
