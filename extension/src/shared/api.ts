import { MESSAGES } from './messages.js';
import { getTaskId, parseMaybeJson } from './api-response.js';
import { normalizeBaseUrl } from './api-url.js';
import { addDeveloperError, getPreferences, saveCaptionState } from './storage.js';
import type { NeoTalkApiResponse, PhraseSource } from './types.js';

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 30;
const activeSubmissions = new Set<string>();

function getFileUrl(response: NeoTalkApiResponse): string | undefined {
  return response.file_url ?? response.fileUrl ?? response.url ?? response.video_url ?? response.result?.file_url ?? response.result?.fileUrl;
}

function buildApiUrls(configuredUrl: string, taskId?: string): { submitUrl: string; statusUrls: string[] } {
  const apiBaseUrl = normalizeBaseUrl(configuredUrl);
  return {
    submitUrl: `${apiBaseUrl}/sign-process-video`,
    statusUrls: taskId ? [`${apiBaseUrl}/task-status-video/${encodeURIComponent(taskId)}`] : []
  };
}

function isTaskPending(response: NeoTalkApiResponse): boolean {
  const status = String(response.status ?? response.state ?? '').toLowerCase();
  return ['pending', 'queued', 'started', 'processing', 'running', 'in_progress', 'accepted'].includes(status);
}

async function readResponsePayload(response: Response): Promise<NeoTalkApiResponse | string> {
  const text = await response.text();
  if (!text.trim()) return response.status === 202 ? { status: 'accepted' } : '';
  const contentType = response.headers.get('content-type') ?? '';
  return contentType.includes('application/json') ? (parseMaybeJson(text) as NeoTalkApiResponse | string) : parseMaybeJson(text);
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function authHeaders(developerMode: boolean, apiKey: string): HeadersInit {
  return developerMode && apiKey.trim().length > 0 ? { 'x-api-key': apiKey.trim() } : {};
}

async function pollTaskStatus(taskId: string, proxyUrl: string, headers: HeadersInit): Promise<NeoTalkApiResponse> {
  const { statusUrls } = buildApiUrls(proxyUrl, taskId);
  if (statusUrls.length === 0) throw new Error('Task status URL indisponível.');

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    await saveCaptionState({ status: `Consultando status da tradução... (${attempt + 1}/${MAX_POLL_ATTEMPTS})` });

    const response = await fetch(statusUrls[0], { method: 'GET', headers });
    const payload = await readResponsePayload(response);
    if (!response.ok) throw new Error(typeof payload === 'string' ? payload : String(payload.error ?? payload.message ?? MESSAGES.translationError));
    if (typeof payload === 'string') throw new Error(payload || MESSAGES.translationError);
    if (getFileUrl(payload)) return payload;
    if (!isTaskPending(payload)) throw new Error(String(payload.error ?? payload.message ?? MESSAGES.translationError));

    if (attempt < MAX_POLL_ATTEMPTS - 1) await sleep(POLL_INTERVAL_MS);
  }

  throw new Error('Tempo limite ao aguardar a tarefa de tradução.');
}

export async function submitPhrase(frase: string, source: PhraseSource): Promise<string | undefined> {
  if (!frase || frase.trim().length === 0) return undefined;

  const trimmed = frase.trim();
  const submissionKey = `${source}:${trimmed}`;
  if (activeSubmissions.has(submissionKey)) return undefined;

  activeSubmissions.add(submissionKey);
  await saveCaptionState({ caption: trimmed, status: MESSAGES.processing, error: undefined });

  try {
    const { proxyUrl, developerMode, apiKey } = await getPreferences();
    const headers = authHeaders(developerMode, apiKey);
    const formData = new FormData();
    formData.append('frase', trimmed);

    const validatedProxyUrl = normalizeBaseUrl(proxyUrl, developerMode);
    const { submitUrl } = buildApiUrls(validatedProxyUrl);
    const response = await fetch(submitUrl, {
      method: 'POST',
      headers,
      body: formData
    });
    const payload = await readResponsePayload(response);

    if (!response.ok) throw new Error(typeof payload === 'string' ? payload : String(payload.message ?? payload.error ?? MESSAGES.translationError));
    if (typeof payload === 'string' && !payload) throw new Error(MESSAGES.translationError);

    const immediateFileUrl = typeof payload === 'string' ? undefined : getFileUrl(payload);
    const taskId = getTaskId(payload);

    if (!immediateFileUrl && !taskId) {
      throw new Error(`A resposta do POST não retornou task_id. Payload: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
    }

    if (taskId) {
      await saveCaptionState({ status: `Task ${taskId} criada. Consultando status...` });
    }

    const finalPayload = immediateFileUrl ? (payload as NeoTalkApiResponse) : await pollTaskStatus(taskId!, validatedProxyUrl, headers);
    const fileUrl = finalPayload ? getFileUrl(finalPayload) : undefined;

    if (!fileUrl) throw new Error(`A task ${taskId ?? ''} terminou sem retornar URL do vídeo.`);

    await saveCaptionState({ caption: trimmed, status: '', fileUrl, error: undefined });
    return fileUrl;
  } catch (error) {
    await saveCaptionState({ caption: trimmed, status: '', error: MESSAGES.translationError });
    await addDeveloperError(MESSAGES.translationError, error);
    console.warn('NeoTalk: falha técnica ao traduzir frase.', error);
    return undefined;
  } finally {
    activeSubmissions.delete(submissionKey);
  }
}
