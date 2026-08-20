import { MESSAGES } from './messages.js';
import { getTaskId, parseMaybeJson } from './api-response.js';
import { normalizeBaseUrl } from './api-url.js';
import { addDeveloperError, getPreferences, saveCaptionState } from './storage.js';
import type { NeoTalkApiResponse, PhraseSource } from './types.js';

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 30;
const FETCH_TIMEOUT_MS = 15_000;
const activeSubmissions = new Set<string>();

/**
 * Um `fetch` sem limite de tempo pode ficar pendurado indefinidamente (rede
 * caiu, servidor não responde) — e como cada trecho transcrito espera o
 * anterior terminar (fila serializada por sessão), isso travava toda a
 * transcrição seguinte, não só a requisição atual.
 */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`A requisição não respondeu em ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function getFileUrl(response: NeoTalkApiResponse): string | undefined {
  return response.file_url ?? response.fileUrl ?? response.url ?? response.video_url ?? response.result?.file_url ?? response.result?.fileUrl;
}

/**
 * As duas chamadas (`submitPhrase`, `pollTaskStatus`) sempre passam uma URL
 * que já veio de `normalizeBaseUrl` com a flag correta de HTTP local — validar
 * de novo aqui, sem essa flag, rejeitaria a mesma URL que acabou de ser aceita
 * (era exatamente o que acontecia com uma URL local de desenvolvimento).
 */
function buildApiUrls(normalizedUrl: string, taskId?: string): { submitUrl: string; statusUrls: string[] } {
  return {
    submitUrl: `${normalizedUrl}/sign-process-video`,
    statusUrls: taskId ? [`${normalizedUrl}/task-status-video/${encodeURIComponent(taskId)}`] : []
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

    const response = await fetchWithTimeout(statusUrls[0], { method: 'GET', headers });
    const payload = await readResponsePayload(response);
    if (!response.ok) throw new Error(typeof payload === 'string' ? payload : String(payload.error ?? payload.message ?? MESSAGES.translationError));
    if (typeof payload === 'string') throw new Error(payload || MESSAGES.translationError);
    if (getFileUrl(payload)) return payload;
    if (!isTaskPending(payload)) throw new Error(String(payload.error ?? payload.message ?? MESSAGES.translationError));

    if (attempt < MAX_POLL_ATTEMPTS - 1) await sleep(POLL_INTERVAL_MS);
  }

  throw new Error('Tempo limite ao aguardar a tarefa de tradução.');
}

/**
 * `skipCaptionUpdate`: quem chama já mostrou o texto na legenda por conta
 * própria, com um status já adequado ao que está acontecendo (é o caso da
 * fila de áudio — ver `queueTranscript` em `background/service-worker.ts`,
 * que inclui quantas frases ainda esperam a vez). Sobrescrever aqui com o
 * status genérico apagaria essa informação assim que `submitPhrase` começa.
 */
export async function submitPhrase(frase: string, source: PhraseSource, skipCaptionUpdate = false): Promise<string | undefined> {
  if (!frase || frase.trim().length === 0) return undefined;

  const trimmed = frase.trim();
  const submissionKey = `${source}:${trimmed}`;
  if (activeSubmissions.has(submissionKey)) return undefined;

  activeSubmissions.add(submissionKey);
  if (!skipCaptionUpdate) await saveCaptionState({ caption: trimmed, status: MESSAGES.processing, error: undefined });

  try {
    const { proxyUrl, developerMode, apiKey } = await getPreferences();
    const headers = authHeaders(developerMode, apiKey);
    const formData = new FormData();
    formData.append('frase', trimmed);

    const validatedProxyUrl = normalizeBaseUrl(proxyUrl, developerMode);
    const { submitUrl } = buildApiUrls(validatedProxyUrl);
    const response = await fetchWithTimeout(submitUrl, {
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

    await saveCaptionState(skipCaptionUpdate ? { status: '', fileUrl, error: undefined } : { caption: trimmed, status: '', fileUrl, error: undefined });
    return fileUrl;
  } catch (error) {
    // Cada causa (timeout do servidor, frase recusada, rede fora do ar) já
    // vem com uma mensagem específica lançada mais acima; mostrar essa
    // mensagem em vez de sempre a genérica é o que permite diagnosticar sem
    // adivinhar.
    const detail = error instanceof Error && error.message ? error.message : MESSAGES.translationError;
    await saveCaptionState(skipCaptionUpdate ? { status: '', error: detail } : { caption: trimmed, status: '', error: detail });
    await addDeveloperError(MESSAGES.translationError, error);
    console.warn('NeoTalk: falha técnica ao traduzir frase.', error);
    return undefined;
  } finally {
    activeSubmissions.delete(submissionKey);
  }
}
