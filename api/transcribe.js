// /api/transcribe.js — Transcripción de audio via Groq Whisper
export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY no configurada' });

  try {
    // Leer body crudo (audio binario enviado como blob)
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const audioBuffer = Buffer.concat(chunks);
    if (!audioBuffer.length) return res.status(400).json({ error: 'Sin audio' });

    // Detectar extensión por content-type
    const mime = (req.headers['content-type'] || 'audio/webm').toLowerCase();
    let ext = 'webm';
    if (mime.includes('ogg')) ext = 'ogg';
    else if (mime.includes('mp4') || mime.includes('m4a')) ext = 'm4a';
    else if (mime.includes('wav')) ext = 'wav';
    else if (mime.includes('mpeg') || mime.includes('mp3')) ext = 'mp3';

    // Construir multipart para Groq (FormData global en Node 18+)
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: mime });
    formData.append('file', blob, `audio.${ext}`);
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'es');
    // response_format=text → cuerpo crudo (sin parseo JSON), más rápido
    formData.append('response_format', 'text');
    formData.append('temperature', '0');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }

    const texto = (await response.text()).trim();
    return res.json({ texto });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
