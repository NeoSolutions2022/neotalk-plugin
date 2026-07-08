import { submitPhrase } from '../shared/api.js';
import { MESSAGES } from '../shared/messages.js';
import { saveCaptionState } from '../shared/storage.js';
import type { RuntimeMessage } from '../shared/types.js';

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

function sendExtensionMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response));
  });
}

async function startTabAudio(): Promise<void> {
  if (!chrome.tabCapture?.getMediaStreamId) {
    await saveCaptionState({ status: '', error: MESSAGES.tabAudioUnsupported });
    return;
  }

  try {
    await saveCaptionState({ status: MESSAGES.listening, error: undefined });
    await ensureOffscreenDocument();
    const streamId = await getCurrentTabStreamId();
    await sendExtensionMessage({ type: 'NEOTALK_OFFSCREEN_START', streamId });
  } catch (error) {
    await saveCaptionState({ status: '', error: MESSAGES.tabAudioUnsupported });
    console.warn('NeoTalk: falha técnica ao capturar áudio da aba.', error);
  }
}

async function stopTabAudio(): Promise<void> {
  try {
    await sendExtensionMessage({ type: 'NEOTALK_OFFSCREEN_STOP' });
  } catch {
    // A ausência temporária do documento offscreen não deve quebrar a UI.
  }
  await saveCaptionState({ status: '', error: undefined });
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  void (async () => {
    if (message.type === 'NEOTALK_SUBMIT_PHRASE') {
      const fileUrl = await submitPhrase(message.frase, message.source);
      sendResponse({ ok: Boolean(fileUrl), fileUrl });
      return;
    }

    if (message.type === 'NEOTALK_TAB_AUDIO_TRANSCRIPT') {
      await saveCaptionState({ status: MESSAGES.transcribing });
      const fileUrl = await submitPhrase(message.frase, 'tab-audio');
      sendResponse({ ok: Boolean(fileUrl), fileUrl });
      return;
    }

    if (message.type === 'NEOTALK_START_TAB_AUDIO') {
      await startTabAudio();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'NEOTALK_STOP_TAB_AUDIO') {
      await stopTabAudio();
      sendResponse({ ok: true });
    }
  })();

  return true;
});
