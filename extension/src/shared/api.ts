import { MESSAGES } from './messages.js';
import { getPreferences, saveCaptionState } from './storage.js';
import type { NeoTalkApiResponse, PhraseSource } from './types.js';

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 30;
const activeSubmissions = new Set<string>();
let lastCompletedSubmission = '';

function getFileUrl(response: NeoTalkApiResponse): string | undefined {
  return response.file_url ?? response.fileUrl ?? response.url ?? response.video_url ?? response.result?.file_url ?? response.result?.fileUrl;
}

function getPollUrl(response: NeoTalkApiResponse, proxyUrl: string): string | undefined {
  const rawPollUrl = response.status_url ?? response.statusUrl ?? response.polling_url;
  if (!rawPollUrl) return undefined;

  const proxyOrigin = new URL(proxyUrl).origin;
  const pollUrl = new URL(rawPollUrl, proxyOrigin);
  return pollUrl.origin === proxyOrigin ? pollUrl.toString() : undefined;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pollForFinalVideo(initialResponse: NeoTalkApiResponse, proxyUrl: string): Promise<NeoTalkApiResponse> {
  let response = initialResponse;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS && !getFileUrl(response); attempt += 1) {
    const pollUrl = getPollUrl(response, proxyUrl);
    if (!pollUrl || response.status === 'failed' || response.status === 'error') break;

    await sleep(POLL_INTERVAL_MS);
    const pollResponse = await fetch(pollUrl);
    response = (await pollResponse.json()) as NeoTalkApiResponse;
  }

  return response;
}

export async function submitPhrase(frase: string, source: PhraseSource): Promise<string | undefined> {
  if (!frase || frase.trim().length === 0) return undefined;

  const trimmed = frase.trim();
  const submissionKey = `${source}:${trimmed}`;
  if (activeSubmissions.has(submissionKey) || lastCompletedSubmission === submissionKey) return undefined;

  activeSubmissions.add(submissionKey);
  await saveCaptionState({ caption: trimmed, status: MESSAGES.processing, error: undefined });

  try {
    const { proxyUrl } = await getPreferences();
    const response = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frase: trimmed })
    });
    const payload = (await response.json()) as NeoTalkApiResponse;

    if (!response.ok) throw new Error(String(payload.message ?? MESSAGES.translationError));

    const finalPayload = await pollForFinalVideo(payload, proxyUrl);
    const fileUrl = getFileUrl(finalPayload);
    await saveCaptionState({ caption: trimmed, status: '', fileUrl, error: undefined });
    lastCompletedSubmission = submissionKey;
    return fileUrl;
  } catch (error) {
    await saveCaptionState({ caption: trimmed, status: '', error: MESSAGES.translationError });
    console.warn('NeoTalk: falha técnica ao traduzir frase.', error);
    return undefined;
  } finally {
    activeSubmissions.delete(submissionKey);
  }
}
