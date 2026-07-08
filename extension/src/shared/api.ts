import { MESSAGES } from './messages.js';
import { addDeveloperError, getPreferences, saveCaptionState } from './storage.js';
import type { NeoTalkApiResponse, PhraseSource } from './types.js';

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 30;
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
    .replace(/\/task-status-pose$/, '')
    .replace(/\/task-status$/, '');
}

function buildApiUrls(configuredUrl: string, taskId?: string): { submitUrl: string; statusUrls: string[] } {
  const apiBaseUrl = normalizeBaseUrl(configuredUrl);
  return {
    submitUrl: `${apiBaseUrl}/sign-process-pose`,
    statusUrls: taskId ? [`${apiBaseUrl}/task-status-pose/${encodeURIComponent(taskId)}`] : []
  };
}

function parseMaybeJson(text: string): NeoTalkApiResponse | string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  try {
    return JSON.parse(trimmed) as NeoTalkApiResponse;
  } catch {
    return trimmed;
  }
}

function getTaskId(response: unknown): string | undefined {
  if (response == null) return undefined;
  if (typeof response === 'number') return String(response);
  if (typeof response === 'string') {
    const parsed = parseMaybeJson(response);
    if (parsed !== response) return getTaskId(parsed);
    return response.trim() || undefined;
  }
  if (typeof response !== 'object') return undefined;

  const payload = response as Record<string, unknown>;
  const directTaskId = payload.task_id ?? payload.taskId ?? payload.taskID ?? payload.id ?? payload.job_id ?? payload.jobId ?? payload.celery_task_id ?? payload.task;
  if (typeof directTaskId === 'string' && directTaskId.trim().length > 0) return directTaskId.trim();
  if (typeof directTaskId === 'number') return String(directTaskId);

  for (const nestedKey of ['data', 'result', 'task', 'payload']) {
    const nestedTaskId = getTaskId(payload[nestedKey]);
    if (nestedTaskId) return nestedTaskId;
  }

  return undefined;
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

    if (response.status !== 202) {
      if (!response.ok && response.status === 404 && statusUrls[1]) {
        const fallbackResponse = await fetch(statusUrls[1], { method: 'GET', headers });
        const fallbackPayload = await readResponsePayload(fallbackResponse);
        if (fallbackResponse.status !== 202) {
          if (!fallbackResponse.ok) throw new Error(typeof fallbackPayload === 'string' ? fallbackPayload : String(fallbackPayload.error ?? fallbackPayload.message ?? MESSAGES.translationError));
          if (typeof fallbackPayload === 'string') throw new Error(fallbackPayload || MESSAGES.translationError);
          if (getFileUrl(fallbackPayload)) return fallbackPayload;
          if (!isTaskPending(fallbackPayload)) throw new Error(MESSAGES.translationError);
        }
      } else {
        if (!response.ok) throw new Error(typeof payload === 'string' ? payload : String(payload.error ?? payload.message ?? MESSAGES.translationError));
        if (typeof payload === 'string') throw new Error(payload || MESSAGES.translationError);
        if (getFileUrl(payload)) return payload;
        if (!isTaskPending(payload)) throw new Error(MESSAGES.translationError);
      }
    }

    if (attempt < MAX_POLL_ATTEMPTS - 1) await sleep(POLL_INTERVAL_MS);
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

    if (!immediateFileUrl && !taskId) {
      throw new Error(`A resposta do POST não retornou task_id. Payload: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
    }

    if (taskId) {
      await saveCaptionState({ status: `Task ${taskId} criada. Consultando status...` });
    }

    const finalPayload = immediateFileUrl ? (payload as NeoTalkApiResponse) : await pollTaskStatus(taskId!, proxyUrl, headers);
    const fileUrl = finalPayload ? getFileUrl(finalPayload) : undefined;

    if (!fileUrl) throw new Error(`A task ${taskId ?? ''} terminou sem retornar URL do vídeo.`);

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
