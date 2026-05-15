// /api/tts.js — ElevenLabs TTS para Kontrol
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { texto, voice_id } = req.body;
  if (!texto || !texto.trim()) {
    return res.status(400).json({ error: 'Sin texto' });
  }

  // Validar voice_id: solo aceptamos IDs alfanuméricos de ElevenLabs (~20 chars)
  const VOICE_ID = (voice_id && /^[A-Za-z0-9]{15,30}$/.test(voice_id))
    ? voice_id
    : (process.env.ELEVENLABS_VOICE_ID || '4vqDWmE9rvDX51nxtDbo');
  const API_KEY  = process.env.ELEVENLABS_API_KEY;

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
          model_id: 'eleven_flash_v2_5', // ~2× más rápido que turbo, calidad similar
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

    // ── Streaming passthrough ──
    // En vez de esperar audio completo (arrayBuffer), reenviamos cada chunk
    // tan pronto ElevenLabs lo genere. El cliente con MediaSource puede
    // empezar a reproducir desde el primer chunk (~300-500ms TTFT).
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); // hint para deshabilitar buffering en proxies

    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (e) {
      console.error('TTS stream interrupted:', e.message);
      try { res.end(); } catch (_) {}
    }

  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    } else {
      try { res.end(); } catch (_) {}
    }
  }
}
