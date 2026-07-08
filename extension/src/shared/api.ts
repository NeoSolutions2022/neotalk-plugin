import { MESSAGES } from './messages.js';
import { addDeveloperError, getPreferences, saveCaptionState } from './storage.js';
import type { NeoTalkApiResponse, PhraseSource } from './types.js';

const POLL_INTERVAL_MS = 1_000;
const MAX_POLL_ATTEMPTS = 60;
const activeSubmissions = new Set<string>();
let lastCompletedSubmission = '';

function getFileUrl(response: NeoTalkApiResponse): string | undefined {
  return response.file_url ?? response.fileUrl ?? response.url ?? response.video_url ?? response.result?.file_url ?? response.result?.fileUrl;
}

function normalizeBaseUrl(configuredUrl: string): string {
  return configuredUrl
    .replace(/\/+$/, '')
    .replace(/\/sign-process-pose$/, '')
    .replace(/\/sign-process-type$/, '')
    .replace(/\/task-status-type$/, '')
    .replace(/\/task-status-pose$/, '');
}

function buildApiUrls(configuredUrl: string, taskId?: string): { submitUrl: string; statusUrls: string[] } {
  const apiBaseUrl = normalizeBaseUrl(configuredUrl);
  return {
    submitUrl: `${apiBaseUrl}/sign-process-pose`,
    statusUrls: taskId ? [`${apiBaseUrl}/task-status-type/${encodeURIComponent(taskId)}`] : []
  };
}

function getTaskId(response: NeoTalkApiResponse | string): string | undefined {
  if (typeof response === 'string') return response.trim() || undefined;
  const taskId = response.task_id ?? response.id ?? response.job_id ?? response.taskId;
  return typeof taskId === 'string' && taskId.trim().length > 0 ? taskId.trim() : undefined;
}

async function readResponsePayload(response: Response): Promise<NeoTalkApiResponse | string> {
  if (response.status === 202) return {};
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return (await response.json()) as NeoTalkApiResponse;
  return (await response.text()).trim();
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
    await sleep(POLL_INTERVAL_MS);
    const response = await fetch(statusUrls[0], { method: 'GET', headers });

    if (response.status === 202) continue;
    const payload = await readResponsePayload(response);
    if (!response.ok && response.status === 404 && statusUrls[1]) {
      const fallbackResponse = await fetch(statusUrls[1], { method: 'GET', headers });
      if (fallbackResponse.status === 202) continue;
      const fallbackPayload = await readResponsePayload(fallbackResponse);
      if (!fallbackResponse.ok) throw new Error(typeof fallbackPayload === 'string' ? fallbackPayload : String(fallbackPayload.error ?? fallbackPayload.message ?? MESSAGES.translationError));
      if (typeof fallbackPayload === 'string') throw new Error(fallbackPayload || MESSAGES.translationError);
      if (getFileUrl(fallbackPayload)) return fallbackPayload;
    }
    if (!response.ok) throw new Error(typeof payload === 'string' ? payload : String(payload.error ?? payload.message ?? MESSAGES.translationError));
    if (typeof payload === 'string') throw new Error(payload || MESSAGES.translationError);
    if (getFileUrl(payload)) return payload;
  }

  throw new Error('Tempo limite ao aguardar a tarefa de tradução.');
}

export async function submitPhrase(frase: string, source: PhraseSource): Promise<string | undefined> {
  if (!frase || frase.trim().length === 0) return undefined;

  const trimmed = frase.trim();
  const submissionKey = `${source}:${trimmed}`;
  if (activeSubmissions.has(submissionKey) || lastCompletedSubmission === submissionKey) return undefined;

  activeSubmissions.add(submissionKey);
  await saveCaptionState({ caption: trimmed, status: MESSAGES.processing, error: undefined });

  try {
    const { proxyUrl, developerMode, apiKey } = await getPreferences();
    const headers = authHeaders(developerMode, apiKey);
    const formData = new FormData();
    formData.append('frase', trimmed);

    const { submitUrl } = buildApiUrls(proxyUrl);
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
    const finalPayload = immediateFileUrl ? (payload as NeoTalkApiResponse) : taskId ? await pollTaskStatus(taskId, proxyUrl, headers) : undefined;
    const fileUrl = finalPayload ? getFileUrl(finalPayload) : undefined;

    if (!fileUrl) throw new Error('A tarefa terminou sem retornar URL do vídeo.');

    await saveCaptionState({ caption: trimmed, status: '', fileUrl, error: undefined });
    lastCompletedSubmission = submissionKey;
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
