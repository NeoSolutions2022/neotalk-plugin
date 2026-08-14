import { submitPhrase } from '../shared/api.js';
import { MESSAGES } from '../shared/messages.js';
import { conflictingMode, shouldIgnoreStart, shouldIgnoreStop } from '../shared/capture-guard.js';
import { addDeveloperError, getAudioCaptureState, migrateStoredApiKey, saveAudioCaptureState, saveCaptionState, saveSelectedText } from '../shared/storage.js';
import type { AudioCaptureMode, CaptureResponse, RuntimeMessage } from '../shared/types.js';

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';
const RESTRICTED_URL = /^(chrome|edge|about|devtools|chrome-extension):/;

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

async function startTabAudio(): Promise<CaptureResponse> {
  if (!chrome.tabCapture?.getMediaStreamId) {
    await saveCaptionState({ status: '', error: MESSAGES.tabAudioUnsupported });
    return { ok: false, error: MESSAGES.tabAudioUnsupported };
  }

  try {
    await saveCaptionState({ status: MESSAGES.listening, error: undefined });
    const tab = await getActiveTab();
    if (!tab?.id || !tab.url || RESTRICTED_URL.test(tab.url) || tab.url.includes('chromewebstore.google.com')) {
      throw new Error('Esta página não permite captura de áudio pelo navegador.');
    }
    await saveAudioCaptureState({ phase: 'starting', mode: 'tab', tabId: tab.id });
    await ensureOffscreenDocument();
    const streamId = await getCurrentTabStreamId(tab.id);
    const result = await sendExtensionMessage({ type: 'NEOTALK_OFFSCREEN_START', streamId });
    if (!result.ok) throw new Error(result.error);
    return result;
  } catch (error) {
    await saveAudioCaptureState({ phase: 'error', mode: 'tab', message: MESSAGES.tabAudioUnsupported });
    await saveCaptionState({ status: '', error: MESSAGES.tabAudioUnsupported });
    await addDeveloperError(MESSAGES.tabAudioUnsupported, error);
    console.warn('NeoTalk: falha técnica ao capturar áudio da aba.', error);
    return { ok: false, error: error instanceof Error ? error.message : MESSAGES.tabAudioUnsupported };
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
    await ensureOffscreenDocument();
    const result = await sendExtensionMessage({ type: 'NEOTALK_OFFSCREEN_START_MIC' });
    if (!result.ok) throw new Error(result.error);
    return result;
  } catch (error) {
    await saveAudioCaptureState({ phase: 'error', mode: 'microphone', message: MESSAGES.speechUnsupported });
    await saveCaptionState({ status: '', error: MESSAGES.speechUnsupported });
    await addDeveloperError(MESSAGES.speechUnsupported, error);
    console.warn('NeoTalk: falha técnica ao capturar microfone.', error);
    return { ok: false, error: error instanceof Error ? error.message : MESSAGES.speechUnsupported };
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
    const phrase = message.frase.trim().slice(0, 5_000);
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
      if (message.source === 'selection') {
        await saveSelectedText(message.frase);
        await saveCaptionState({ caption: message.frase, status: 'Texto selecionado pronto para traduzir.', error: undefined });
      }
      const fileUrl = await submitPhrase(message.frase, message.source);
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
