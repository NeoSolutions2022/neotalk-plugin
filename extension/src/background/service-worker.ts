import { submitPhrase } from '../shared/api.js';
import { MESSAGES } from '../shared/messages.js';
import { addDeveloperError, migrateStoredApiKey, saveCaptionState, saveSelectedText } from '../shared/storage.js';
import type { CaptureResponse, RuntimeMessage } from '../shared/types.js';

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';

async function ensureOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen?.createDocument) throw new Error('offscreen-unavailable');

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
  });

  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Transcrever áudio da aba atual para tradução em Libras.'
  });
}

async function getCurrentTabStreamId(): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({}, (streamId) => {
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
    await ensureOffscreenDocument();
    const streamId = await getCurrentTabStreamId();
    const result = await sendExtensionMessage({ type: 'NEOTALK_OFFSCREEN_START', streamId });
    if (!result.ok) throw new Error(result.error);
    return result;
  } catch (error) {
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

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  void (async () => {
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
      sendResponse(await startTabAudio());
      return;
    }

    if (message.type === 'NEOTALK_STOP_TAB_AUDIO') {
      sendResponse(await stopTabAudio());
      return;
    }

    if (message.type === 'NEOTALK_START_MICROPHONE') {
      sendResponse(await startMicrophone());
      return;
    }

    if (message.type === 'NEOTALK_STOP_MICROPHONE') {
      sendResponse(await stopMicrophone());
    }
  })();

  return true;
});
