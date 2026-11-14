// /lib/whisper-prompt.js — Vocabulario para Whisper (Groq): nombres de los contactos del
// usuario y palabras de Kontrol. Whisper usa el "prompt" como pista de cómo se escriben las
// palabras raras: así "Johanny" no sale "Yúlzale". No es una instrucción, solo contexto.
// Groq admite hasta 224 tokens de prompt: se recorta por caracteres para quedar holgado.

const supabase = require('./supabase');

const MAX_CARACTERES = 500;
const PALABRAS_KONTROL = ['Kontrol', 'Ana', 'Agenda', 'Listado', 'Pagos', 'Caja fuerte', 'Ingresos', 'Claves',
  'Nequi', 'Daviplata', 'Bancolombia', 'WhatsApp'];

function construirPromptWhisper(nombres = []) {
  const base = `Mensaje de voz en español de Colombia para Kontrol: ${PALABRAS_KONTROL.join(', ')}.`;
  const vistos = new Set();
  const limpios = nombres
    .map(n => String(n || '').replace(/[^\p{L}\p{N} .'-]/gu, ' ').replace(/\s+/g, ' ').trim())
    .filter(n => n && n.length <= 40 && !vistos.has(n.toLowerCase()) && vistos.add(n.toLowerCase()));
  if (!limpios.length) return base;
  let prompt = `${base} Contactos: `;
  const elegidos = [];
  for (const n of limpios) {
    if (prompt.length + elegidos.join(', ').length + n.length + 3 > MAX_CARACTERES) break;
    elegidos.push(n);
  }
  return `${prompt}${elegidos.join(', ')}.`;
}

// Prompt con los contactos del usuario. Si algo falla, el vocabulario base (nunca rompe).
async function promptParaUsuario(userId) {
  if (!userId) return construirPromptWhisper();
  try {
    const { data, error } = await supabase.from('contactos').select('nombre')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(60);
    if (error) throw new Error(error.message);
    return construirPromptWhisper((data || []).map(c => c.nombre));
  } catch (e) {
    console.warn('[whisper-prompt] sin contactos:', e.message);
    return construirPromptWhisper();
  }
}

module.exports = { construirPromptWhisper, promptParaUsuario, MAX_CARACTERES };
