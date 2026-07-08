import { Router } from 'express';

const router = Router();

type NeoTalkResponse = Record<string, unknown>;

function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, '');
}

function readNeoTalkConfig() {
  const NEOTALK_API_URL = process.env.NEOTALK_API_URL;
  const NEOTALK_API_KEY = process.env.NEOTALK_API_KEY;

  return { NEOTALK_API_URL, NEOTALK_API_KEY };
}

async function proxyNeoTalkStatus(id: string) {
  const { NEOTALK_API_URL, NEOTALK_API_KEY } = readNeoTalkConfig();

  if (!NEOTALK_API_URL || !NEOTALK_API_KEY) {
    throw new Error('missing-config');
  }

  const response = await fetch(`${normalizeApiUrl(NEOTALK_API_URL)}/sign-process-pose/${encodeURIComponent(id)}`, {
    headers: { 'x-api-key': NEOTALK_API_KEY }
  });
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? ((await response.json()) as NeoTalkResponse)
    : { message: await response.text() };

  return { response, payload };
}

router.post('/translate', async (req, res) => {
  const frase = typeof req.body?.frase === 'string' ? req.body.frase : '';

  if (!frase || frase.trim().length === 0) {
    return res.status(400).json({ message: 'Digite ou selecione um texto para traduzir.' });
  }

  const { NEOTALK_API_URL, NEOTALK_API_KEY } = readNeoTalkConfig();

  if (!NEOTALK_API_URL || !NEOTALK_API_KEY) {
    return res.status(500).json({ message: 'Configuração do NeoTalk indisponível.' });
  }

  try {
    const response = await fetch(`${normalizeApiUrl(NEOTALK_API_URL)}/sign-process-pose`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': NEOTALK_API_KEY
      },
      body: JSON.stringify({ frase: frase.trim() })
    });

    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json')
      ? ((await response.json()) as NeoTalkResponse)
      : { message: await response.text() };

    return res.status(response.status).json(payload);
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Erro ao chamar NeoTalk API:', error);
    }

    return res.status(502).json({ message: 'Não foi possível processar a tradução agora.' });
  }
});

router.get('/status/:id', async (req, res) => {
  try {
    const { response, payload } = await proxyNeoTalkStatus(req.params.id);
    return res.status(response.status).json(payload);
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Erro ao consultar status NeoTalk:', error);
    }

    const status = error instanceof Error && error.message === 'missing-config' ? 500 : 502;
    return res.status(status).json({ message: 'Não foi possível consultar a tradução agora.' });
  }
});

export default router;

