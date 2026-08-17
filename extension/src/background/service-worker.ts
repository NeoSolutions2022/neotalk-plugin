import { submitPhrase } from '../shared/api.js';
import { MESSAGES } from '../shared/messages.js';
import { conflictingMode, shouldIgnoreStart, shouldIgnoreStop } from '../shared/capture-guard.js';
import { withTimeout } from '../shared/timeout.js';
import { sanitizePhrase } from '../shared/text.js';
import { addDeveloperError, getAudioCaptureState, migrateStoredApiKey, saveAudioCaptureState, saveCaptionState, saveSelectedText } from '../shared/storage.js';
import type { AudioCaptureMode, CaptureResponse, RuntimeMessage } from '../shared/types.js';

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';
const RESTRICTED_URL = /^(chrome|edge|about|devtools|chrome-extension):/;
const RESTRICTED_PAGE_MESSAGE = 'Esta página não permite captura de áudio pelo navegador.';

/** Serializa os pedidos para dois cliques rapidos nao se atropelarem. */
let captureChain: Promise<CaptureResponse> = Promise.resolve({ ok: true });

function queueCapture(operation: () => Promise<CaptureResponse>): Promise<CaptureResponse> {
  const next = captureChain.then(operation, operation);
  captureChain = next.catch(() => ({ ok: false }));
  return next;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen?.createDocument) throw new Error('offscreen-unavailable');

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
  });

  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'Transcrever áudio da aba atual para tradução em Libras.'
  });
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}

async function getCurrentTabStreamId(targetTabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      const error = chrome.runtime.lastError;
      if (error || !streamId) {
        reject(new Error(error?.message ?? 'stream-unavailable'));
        return;
      }
      resolve(streamId);
    });
  });
}

function sendExtensionMessage(message: RuntimeMessage): Promise<CaptureResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: CaptureResponse | undefined) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response ?? { ok: false, error: 'O documento de áudio não respondeu.' });
    });
  });
}

const OFFSCREEN_READY_ATTEMPTS = 10;
const OFFSCREEN_READY_DELAY_MS = 200;
const OFFSCREEN_ATTEMPT_TIMEOUT_MS = 1_000;

/**
 * chrome.offscreen.createDocument() resolve assim que o documento é criado,
 * não quando seu script termina de carregar e registra o listener de
 * mensagens — o bundle do offscreen é grande (inclui o motor de
 * transcrição). Enviar a mensagem de início logo em seguida pode chegar
 * antes do listener existir.
 *
 * chrome.runtime.sendMessage também pode nunca chamar seu callback (nem
 * sucesso, nem lastError) quando o destino ainda não está pronto — sem um
 * timeout por tentativa, um único `await` ficaria pendurado para sempre e o
 * retry nunca teria chance de rodar de novo. Cada tentativa é limitada a 1s;
 * passado isso, tenta de novo por até ~10s no total antes de desistir.
 */
async function sendToOffscreen(message: RuntimeMessage): Promise<CaptureResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < OFFSCREEN_READY_ATTEMPTS; attempt += 1) {
    try {
      return await withTimeout(sendExtensionMessage(message), OFFSCREEN_ATTEMPT_TIMEOUT_MS, 'offscreen-timeout');
    } catch (error) {
      lastError = error;
      const retryable = error instanceof Error &&
        (error.message.includes('Could not establish connection') || error.message === 'offscreen-timeout');
      if (!retryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, OFFSCREEN_READY_DELAY_MS));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('offscreen-unavailable');
}

async function startTabAudio(): Promise<CaptureResponse> {
  if (!chrome.tabCapture?.getMediaStreamId) {
    await saveCaptionState({ status: '', error: MESSAGES.tabAudioUnsupported });
    return { ok: false, error: MESSAGES.tabAudioUnsupported };
  }

  try {
    await saveCaptionState({ status: MESSAGES.listening, error: undefined });
    const tab = await getActiveTab();
    if (!tab?.id || !tab.url || RESTRICTED_URL.test(tab.url) || tab.url.includes('chromewebstore.google.com')) {
      throw new Error(RESTRICTED_PAGE_MESSAGE);
    }
    await saveAudioCaptureState({ phase: 'starting', mode: 'tab', tabId: tab.id });
    await ensureOffscreenDocument();
    const streamId = await getCurrentTabStreamId(tab.id);
    const result = await sendToOffscreen({ type: 'NEOTALK_OFFSCREEN_START', streamId });
    if (!result.ok) throw new Error(result.error);
    return result;
  } catch (error) {
    const displayed = error instanceof Error && error.message === RESTRICTED_PAGE_MESSAGE ? RESTRICTED_PAGE_MESSAGE : MESSAGES.tabAudioStartFailed;
    await saveAudioCaptureState({ phase: 'error', mode: 'tab', message: displayed });
    await saveCaptionState({ status: '', error: displayed });
    await addDeveloperError(displayed, error);
    console.warn('NeoTalk: falha técnica ao capturar áudio da aba.', error);
    return { ok: false, error: displayed };
  }
}

async function stopTabAudio(): Promise<CaptureResponse> {
  try {
    await sendExtensionMessage({ type: 'NEOTALK_OFFSCREEN_STOP' });
  } catch {
    // A ausência temporária do documento offscreen não deve quebrar a UI.
  }
  await saveCaptionState({ status: '', error: undefined });
  return { ok: true };
}
async function startMicrophone(): Promise<CaptureResponse> {
  try {
    await saveCaptionState({ status: MESSAGES.listening, error: undefined });
    await saveAudioCaptureState({ phase: 'starting', mode: 'microphone' });
    await ensureOffscreenDocument();
    const result = await sendToOffscreen({ type: 'NEOTALK_OFFSCREEN_START_MIC' });
    if (!result.ok) throw new Error(result.error);
    return result;
  } catch (error) {
    await saveAudioCaptureState({ phase: 'error', mode: 'microphone', message: MESSAGES.microphoneStartFailed });
    await saveCaptionState({ status: '', error: MESSAGES.microphoneStartFailed });
    await addDeveloperError(MESSAGES.microphoneStartFailed, error);
    console.warn('NeoTalk: falha técnica ao capturar microfone.', error);
    return { ok: false, error: MESSAGES.microphoneStartFailed };
  }
}

async function stopMicrophone(): Promise<CaptureResponse> {
  try {
    await sendExtensionMessage({ type: 'NEOTALK_OFFSCREEN_STOP_MIC' });
  } catch {
    // A ausência temporária do documento offscreen não deve quebrar a UI.
  }
  await saveCaptionState({ status: '', error: undefined });
  return { ok: true };
}

async function requestStart(mode: AudioCaptureMode): Promise<CaptureResponse> {
  const now = Date.now();
  const current = await getAudioCaptureState();
  if (shouldIgnoreStart(current, mode, now)) return { ok: true };

  // Só uma fonte por vez: transcrições sobrepostas chegariam embaralhadas.
  if (conflictingMode(current, mode)) await requestStop();

  return mode === 'tab' ? startTabAudio() : startMicrophone();
}

async function requestStop(): Promise<CaptureResponse> {
  const current = await getAudioCaptureState();
  if (shouldIgnoreStop(current, Date.now())) return { ok: true };
  await saveAudioCaptureState({ phase: 'stopping', mode: current.mode, sessionId: current.sessionId });
  return current.mode === 'microphone' ? stopMicrophone() : stopTabAudio();
}

const transcriptionChains = new Map<string, Promise<void>>();
const lastSequences = new Map<string, number>();

function queueTranscript(message: Extract<RuntimeMessage, { type: 'NEOTALK_TAB_AUDIO_TRANSCRIPT' }>): Promise<void> {
  const previous = transcriptionChains.get(message.sessionId) ?? Promise.resolve();
  const next = previous.then(async () => {
    if (message.sequence <= (lastSequences.get(message.sessionId) ?? 0)) return;
    lastSequences.set(message.sessionId, message.sequence);
    // normalizeTranscript já tratou os artefatos da transcrição; aqui sobra
    // o que quebra a API: emoji, invisíveis, pontuação tipográfica.
    const phrase = sanitizePhrase(message.frase, { maxChars: 5_000 });
    if (!phrase) return;
    await saveCaptionState({ status: MESSAGES.transcribing });
    await submitPhrase(phrase, message.mode === 'microphone' ? 'microphone' : 'tab-audio');
  }).finally(() => {
    if (transcriptionChains.get(message.sessionId) === next) transcriptionChains.delete(message.sessionId);
  });
  transcriptionChains.set(message.sessionId, next);
  return next;
}

void migrateStoredApiKey();
chrome.runtime.onInstalled.addListener(() => void migrateStoredApiKey());

function resetCaptureState(): void {
  void saveAudioCaptureState({ phase: 'inactive' });
}

chrome.runtime.onStartup.addListener(resetCaptureState);
chrome.runtime.onInstalled.addListener(resetCaptureState);

/** Fechar a aba capturada encerra a captura. */
chrome.tabs.onRemoved.addListener((tabId) => {
  void getAudioCaptureState().then((state) => {
    if (state.mode === 'tab' && state.tabId === tabId) void queueCapture(requestStop);
  });
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  void (async () => {
    // O balão precisa saber em que aba está, para o botão da aba não aparecer
    // como ativo nas outras.
    if (message.type === 'NEOTALK_WHICH_TAB') {
      sendResponse({ tabId: sender.tab?.id ?? null });
      return;
    }

    if (message.type === 'NEOTALK_SUBMIT_PHRASE') {
      const frase = sanitizePhrase(message.frase);
      if (!frase) {
        await saveCaptionState({ caption: message.frase, status: '', error: MESSAGES.nothingToTranslate });
        sendResponse({ ok: false, error: MESSAGES.nothingToTranslate });
        return;
      }
      if (message.source === 'selection') {
        await saveSelectedText(frase);
        await saveCaptionState({ caption: frase, status: 'Texto selecionado pronto para traduzir.', error: undefined });
      }
      const fileUrl = await submitPhrase(frase, message.source);
      sendResponse({ ok: Boolean(fileUrl), fileUrl });
      return;
    }

    if (message.type === 'NEOTALK_TAB_AUDIO_TRANSCRIPT') {
      await queueTranscript(message);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'NEOTALK_START_TAB_AUDIO') {
      sendResponse(await queueCapture(() => requestStart('tab')));
      return;
    }

    if (message.type === 'NEOTALK_STOP_TAB_AUDIO') {
      sendResponse(await queueCapture(requestStop));
      return;
    }

    if (message.type === 'NEOTALK_START_MICROPHONE') {
      sendResponse(await queueCapture(() => requestStart('microphone')));
      return;
    }

    if (message.type === 'NEOTALK_STOP_MICROPHONE') {
      sendResponse(await queueCapture(requestStop));
    }
  })();

  return true;
});
