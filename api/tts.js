// /api/tts.js — ElevenLabs TTS para Kontrol
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { texto } = req.body;
  if (!texto || !texto.trim()) {
    return res.status(400).json({ error: 'Sin texto' });
  }

  const API_KEY  = process.env.ELEVENLABS_API_KEY;
  const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '4vqDWmE9rvDX51nxtDbo';

  if (!API_KEY) {
    return res.status(500).json({ error: 'ELEVENLABS_API_KEY no configurada' });
  }

  const limpio = texto
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[*_#`═>]/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\$/g, ' pesos ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
          text: limpio,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.80,
            style: 0.25,
            use_speaker_boost: true
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const audioBuffer = await response.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Length', audioBuffer.byteLength);
    res.send(Buffer.from(audioBuffer));

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
} 
