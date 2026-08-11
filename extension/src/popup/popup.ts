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

const CAPTURE_LABELS = {
  starting: 'Preparando a captura de áudio…',
  'loading-model': 'Carregando o transcritor (a primeira vez pode demorar)…',
  recording: 'Captura ativa. Ouvindo áudio…',
  transcribing: 'Transcrevendo e enviando para a NeoTalk…',
  stopping: 'Finalizando a captura…'
} as const;

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
  if (capture.phase === 'error') {
    statusElement.textContent = capture.message ?? state.error ?? 'Não foi possível iniciar a captura.';
    statusElement.classList.add('error');
  } else if (capture.phase in CAPTURE_LABELS) {
    statusElement.textContent = CAPTURE_LABELS[capture.phase as keyof typeof CAPTURE_LABELS];
    statusElement.classList.remove('error');
  }
  const transitioning = ['starting', 'loading-model', 'stopping'].includes(capture.phase);
  microphoneButton.disabled = transitioning || (capture.phase !== 'inactive' && capture.phase !== 'error' && capture.mode !== 'microphone');
  tabAudioButton.disabled = transitioning || (capture.phase !== 'inactive' && capture.phase !== 'error' && capture.mode !== 'tab');
  microphoneButton.textContent = capture.mode === 'microphone' && !['inactive', 'error'].includes(capture.phase)
    ? (transitioning ? 'Preparando microfone…' : 'Parar microfone')
    : (capture.mode === 'microphone' && capture.phase === 'error' ? 'Tentar microfone novamente' : 'Ativar microfone');
  tabAudioButton.textContent = capture.mode === 'tab' && !['inactive', 'error'].includes(capture.phase)
    ? (transitioning ? 'Preparando áudio…' : 'Desativar áudio da aba')
    : (capture.mode === 'tab' && capture.phase === 'error' ? 'Tentar áudio novamente' : 'Ativar áudio da aba');
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
    const response = await sendRuntimeMessage({ type: active ? 'NEOTALK_STOP_TAB_AUDIO' : 'NEOTALK_START_TAB_AUDIO' });
    if (!response?.ok) await saveCaptionState({ status: '', error: response?.error ?? MESSAGES.tabAudioUnsupported });
    await refreshUi();
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
