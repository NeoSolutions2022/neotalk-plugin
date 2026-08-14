import { MESSAGES } from '../shared/messages.js';
import { saveCaptionState } from '../shared/storage.js';
import type { RuntimeMessage } from '../shared/types.js';
import type { SpeechRecognition, SpeechRecognitionResultEvent } from '../shared/speech.js';


let stream: MediaStream | null = null;
let recognition: SpeechRecognition | null = null;
let sessionId = '';
let sequence = 0;
let audioContext: AudioContext | null = null;

function stopCapture(): void {
  recognition?.stop();
  recognition = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  void audioContext?.close();
  audioContext = null;
}

async function startCapture(streamId: string): Promise<void> {
  const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    await saveCaptionState({ status: '', error: MESSAGES.speechUnsupported });
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      } as MediaTrackConstraints,
      video: false
    });
    sessionId = crypto.randomUUID();
    sequence = 0;
    audioContext = new AudioContext();
    audioContext.createMediaStreamSource(stream).connect(audioContext.destination);

    recognition = new SpeechRecognition();
    recognition.lang = 'pt-BR';
    recognition.continuous = true;
    recognition.onstart = () => void saveCaptionState({ status: MESSAGES.listening, error: undefined });
    recognition.onresult = (event: SpeechRecognitionResultEvent) => {
      const texto = event.results[event.results.length - 1][0].transcript;
      void saveCaptionState({ status: MESSAGES.transcribing, caption: texto, error: undefined })
        .then(() => chrome.runtime.sendMessage({ type: 'NEOTALK_TAB_AUDIO_TRANSCRIPT', frase: texto, sessionId, sequence: sequence++, mode: 'tab-audio' }));
    };
    recognition.onerror = () => void saveCaptionState({ status: '', error: MESSAGES.tabAudioUnsupported });
    recognition.start();
  } catch {
    await saveCaptionState({ status: '', error: MESSAGES.tabAudioUnsupported });
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage) => {
  if (message.type === 'NEOTALK_OFFSCREEN_START') void startCapture(message.streamId);
  if (message.type === 'NEOTALK_OFFSCREEN_STOP') stopCapture();
});
