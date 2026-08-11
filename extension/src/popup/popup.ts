import { updateAvatarVideo } from '../shared/avatar.js';
import { renderCaptionState } from '../shared/captions.js';
import { MESSAGES } from '../shared/messages.js';
import { CAPTION_STATE_KEY, getCaptionState, getPreferences, getSelectedText, markWelcomeSent, saveCaptionState, savePreferences, wasWelcomeSent } from '../shared/storage.js';
import type { RuntimeMessage } from '../shared/types.js';

const captionElement = document.querySelector<HTMLElement>('#caption')!;
const statusElement = document.querySelector<HTMLElement>('#status')!;
const videoElement = document.querySelector<HTMLVideoElement>('#avatar-video')!;
const placeholderElement = document.querySelector<HTMLElement>('#avatar-placeholder')!;
const manualText = document.querySelector<HTMLTextAreaElement>('#manualText')!;
const tabAudioButton = document.querySelector<HTMLButtonElement>('#tabAudioButton')!;
const microphoneButton = document.querySelector<HTMLButtonElement>('#microphoneButton')!;
const selectionModeButton = document.querySelector<HTMLButtonElement>('#selectionModeButton')!;
let tabAudioEnabled = false;
let isMicrophoneActive = false;

async function refreshUi(): Promise<void> {
  const state = await getCaptionState();
  const preferences = await getPreferences();
  renderCaptionState(captionElement, statusElement, state);
  const selectedText = await getSelectedText();
  if (selectedText && manualText.value.trim().length === 0) manualText.value = selectedText;
  selectionModeButton.textContent = preferences.selectionModeEnabled ? 'Desativar modo seleção' : 'Ativar modo seleção';
  document.querySelector('#avatar-container')?.classList.toggle('expanded', preferences.avatarExpanded);
  if (state.fileUrl) {
    placeholderElement.hidden = true;
    updateAvatarVideo(videoElement, state.fileUrl);
  }
}

async function sendRuntimeMessage(message: RuntimeMessage): Promise<void> {
  await chrome.runtime.sendMessage(message);
  await refreshUi();
}

async function submitManualPhrase(): Promise<void> {
  const frase = manualText.value;
  if (!frase || frase.trim().length === 0) {
    await saveCaptionState({ status: MESSAGES.empty, error: undefined });
    await refreshUi();
    return;
  }

  await sendRuntimeMessage({ type: 'NEOTALK_SUBMIT_PHRASE', frase, source: 'manual' });
}

async function sendWelcomeOnce(): Promise<void> {
  const preferences = await getPreferences();
  if (!preferences.autoWelcomeEnabled || await wasWelcomeSent()) return;
  await markWelcomeSent();
  await sendRuntimeMessage({ type: 'NEOTALK_SUBMIT_PHRASE', frase: 'Seja bem-vindo' /* também atende ao fluxo inicial de boas-vindas ao abrir a extensão */, source: 'welcome' });
}

document.querySelector('#translateButton')?.addEventListener('click', () => void submitManualPhrase());

async function ensureMicrophonePermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop()); // só precisávamos do prompt, não do stream em si
    return true;
  } catch (error) {
    console.warn('NeoTalk: permissão de microfone negada ou indisponível.', error);
    await saveCaptionState({ status: '', error: MESSAGES.speechUnsupported });
    await refreshUi();
    return false;
  }
}

microphoneButton.addEventListener('click', () => {
  void (async () => {
    if (!isMicrophoneActive) {
      const granted = await ensureMicrophonePermission();
      if (!granted) return; // não liga o toggle se a permissão foi negada
    }

    isMicrophoneActive = !isMicrophoneActive;
    microphoneButton.textContent = isMicrophoneActive ? 'Parar microfone' : 'Ativar microfone';
    void sendRuntimeMessage({ type: isMicrophoneActive ? 'NEOTALK_START_MICROPHONE' : 'NEOTALK_STOP_MICROPHONE' });
  })();
});

tabAudioButton.addEventListener('click', () => {
  tabAudioEnabled = !tabAudioEnabled;
  tabAudioButton.textContent = tabAudioEnabled ? 'Desativar áudio da aba' : 'Ativar áudio da aba';
  void sendRuntimeMessage({ type: tabAudioEnabled ? 'NEOTALK_START_TAB_AUDIO' : 'NEOTALK_STOP_TAB_AUDIO' });
});

selectionModeButton.addEventListener('click', () => {
  void getPreferences()
    .then((preferences) => savePreferences({ ...preferences, selectionModeEnabled: !preferences.selectionModeEnabled }))
    .then(refreshUi);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[CAPTION_STATE_KEY]) void refreshUi();
});

void refreshUi().then(sendWelcomeOnce);