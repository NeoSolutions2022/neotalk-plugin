import { updateAvatarVideo } from '../shared/avatar.js';
import { renderCaptionState } from '../shared/captions.js';
import { MESSAGES } from '../shared/messages.js';
import { AUDIO_CAPTURE_STATE_KEY, CAPTION_STATE_KEY, getAudioCaptureState, getCaptionState, getPreferences, getSelectedText, getSessionTranscript, markWelcomeSent, saveCaptionState, savePreferences, wasWelcomeSent } from '../shared/storage.js';
import type { CaptureResponse, RuntimeMessage } from '../shared/types.js';

const captionElement = document.querySelector<HTMLElement>('#caption')!;
const statusElement = document.querySelector<HTMLElement>('#status')!;
const videoElement = document.querySelector<HTMLVideoElement>('#avatar-video')!;
const placeholderElement = document.querySelector<HTMLElement>('#avatar-placeholder')!;
const manualText = document.querySelector<HTMLTextAreaElement>('#manualText')!;
const tabAudioButton = document.querySelector<HTMLButtonElement>('#tabAudioButton')!;
const microphoneButton = document.querySelector<HTMLButtonElement>('#microphoneButton')!;
const selectionModeButton = document.querySelector<HTMLButtonElement>('#selectionModeButton')!;
const downloadTranscriptButton = document.querySelector<HTMLButtonElement>('#downloadTranscriptButton')!;

async function refreshUi(): Promise<void> {
  const state = await getCaptionState();
  const preferences = await getPreferences();
  const capture = await getAudioCaptureState();
  renderCaptionState(captionElement, statusElement, state);
  const selectedText = await getSelectedText();
  if (selectedText && manualText.value.trim().length === 0) manualText.value = selectedText;
  selectionModeButton.textContent = preferences.selectionModeEnabled ? 'Desativar modo seleção' : 'Ativar modo seleção';
  captionElement.hidden = !preferences.captionsEnabled;
  document.querySelector('#avatar-container')?.classList.toggle('expanded', preferences.avatarExpanded);
  if (state.fileUrl) {
    placeholderElement.hidden = true;
    updateAvatarVideo(videoElement, state.fileUrl);
  }
  const transitioning = ['starting', 'loading-model', 'stopping'].includes(capture.phase);
  microphoneButton.disabled = transitioning || (capture.phase !== 'inactive' && capture.phase !== 'error' && capture.mode !== 'microphone');
  tabAudioButton.disabled = transitioning || (capture.phase !== 'inactive' && capture.phase !== 'error' && capture.mode !== 'tab');
  microphoneButton.textContent = capture.mode === 'microphone' && !['inactive', 'error'].includes(capture.phase) ? 'Parar microfone' : 'Ativar microfone';
  tabAudioButton.textContent = capture.mode === 'tab' && !['inactive', 'error'].includes(capture.phase) ? 'Desativar áudio da aba' : 'Ativar áudio da aba';
  downloadTranscriptButton.hidden = (await getSessionTranscript()).length === 0;
}

async function sendRuntimeMessage(message: RuntimeMessage): Promise<CaptureResponse> {
  const response = await chrome.runtime.sendMessage(message) as CaptureResponse;
  await refreshUi();
  return response;
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

microphoneButton.addEventListener('click', () => {
  void (async () => {
    const capture = await getAudioCaptureState();
    microphoneButton.disabled = true;
    const response = await sendRuntimeMessage({ type: capture.mode === 'microphone' && !['inactive', 'error'].includes(capture.phase) ? 'NEOTALK_STOP_MICROPHONE' : 'NEOTALK_START_MICROPHONE' });
    if (!response?.ok) await saveCaptionState({ status: '', error: response?.error ?? MESSAGES.speechUnsupported });
    await refreshUi();
  })();
});

tabAudioButton.addEventListener('click', () => {
  void (async () => {
    const capture = await getAudioCaptureState();
    tabAudioButton.disabled = true;
    const active = capture.mode === 'tab' && !['inactive', 'error'].includes(capture.phase);
    await sendRuntimeMessage({ type: active ? 'NEOTALK_STOP_TAB_AUDIO' : 'NEOTALK_START_TAB_AUDIO' });
  })();
});

selectionModeButton.addEventListener('click', () => {
  void getPreferences()
    .then((preferences) => savePreferences({ ...preferences, selectionModeEnabled: !preferences.selectionModeEnabled }))
    .then(refreshUi);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[CAPTION_STATE_KEY]) void refreshUi();
  if (areaName === 'local' && changes[AUDIO_CAPTURE_STATE_KEY]) void refreshUi();
});

downloadTranscriptButton.addEventListener('click', () => {
  void getSessionTranscript().then((transcript) => {
    if (!transcript) return;
    const url = URL.createObjectURL(new Blob([transcript], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `neotalk-transcricao-${Date.now()}.txt`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  });
});

void refreshUi().then(sendWelcomeOnce);
