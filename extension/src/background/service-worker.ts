import { submitPhrase } from '../shared/api.js';
import { MESSAGES } from '../shared/messages.js';
import { addDeveloperError, appendConversationMessage, clearConversation, saveCaptionState, saveSelectedText, updateConversationMessage } from '../shared/storage.js';
import type { ConversationMessage, PhraseSource, RuntimeMessage } from '../shared/types.js';

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

function sendExtensionMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response));
  });
}

async function startTabAudio(sender: chrome.runtime.MessageSender): Promise<void> {
  if (!chrome.tabCapture?.getMediaStreamId) {
    await saveCaptionState({ status: '', error: MESSAGES.tabAudioUnsupported });
    return;
  }

  try {
    await saveCaptionState({ status: MESSAGES.listening, error: undefined });
    const tab = sender.tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.id || !tab.url || /^(chrome|edge|about|devtools|chrome-extension):/.test(tab.url) || tab.url.includes('chromewebstore.google.com')) throw new Error('restricted-page');
    const streamId = await getCurrentTabStreamId(tab.id);
    await ensureOffscreenDocument();
    await sendExtensionMessage({ type: 'NEOTALK_OFFSCREEN_START', streamId });
  } catch (error) {
    await saveCaptionState({ status: '', error: MESSAGES.tabAudioUnsupported });
    await addDeveloperError(MESSAGES.tabAudioUnsupported, error);
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

async function translate(frase: string, source: PhraseSource, existingId?: string): Promise<{ ok: boolean; fileUrl?: string; messageId: string }> {
  const text = frase.trim().slice(0, 4000);
  const messageId = existingId ?? crypto.randomUUID();
  const now = Date.now();
  const message: ConversationMessage = { id: messageId, role: 'user', source, text, status: 'submitting', createdAt: now, updatedAt: now };
  if (!existingId) await appendConversationMessage(message); else await updateConversationMessage(messageId, { text, status: 'submitting', error: undefined });
  const fileUrl = await submitPhrase(text, source, (status) => updateConversationMessage(messageId, { status }));
  await updateConversationMessage(messageId, fileUrl ? { status: 'completed', fileUrl, error: undefined } : { status: 'failed', error: MESSAGES.translationError });
  return { ok: Boolean(fileUrl), fileUrl, messageId };
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  void (async () => {
    if (message.type === 'NEOTALK_SUBMIT_PHRASE') {
      if (message.source === 'selection') {
        await saveSelectedText(message.frase);
        await saveCaptionState({ caption: message.frase, status: 'Texto selecionado pronto para traduzir.', error: undefined });
      }
      sendResponse(await translate(message.frase, message.source, message.messageId));
      return;
    }

    if (message.type === 'NEOTALK_TAB_AUDIO_TRANSCRIPT') {
      await saveCaptionState({ status: MESSAGES.transcribing });
      sendResponse(await translate(message.frase, message.mode));
      return;
    }

    if (message.type === 'NEOTALK_START_TAB_AUDIO') {
      await startTabAudio(sender);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'NEOTALK_STOP_TAB_AUDIO') {
      await stopTabAudio();
      sendResponse({ ok: true });
    }
    if (message.type === 'NEOTALK_CLEAR_CONVERSATION') { await clearConversation(); sendResponse({ ok: true }); }
  })();

  return true;
});
