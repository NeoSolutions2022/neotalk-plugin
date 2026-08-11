import { MESSAGES } from '../shared/messages.js';
import { addDeveloperError, saveCaptionState } from '../shared/storage.js';
import type { RuntimeMessage } from '../shared/types.js';
import { pipeline, env } from '@xenova/transformers';

let stream: MediaStream | null = null;
let transcriber: Awaited<ReturnType<typeof pipeline>> | null = null;
let isListening = false;
let activeRecorder: MediaRecorder | null = null;
let sessionTranscript: string[] = [];
const transcriptionQueue: Blob[] = [];
let isProcessingQueue = false;

const RECORD_CHUNK_MS = 15000; // duração de cada bloco de gravação — ajustável para os testes

async function ensureTranscriber() {
  if (transcriber) return transcriber;
  console.log('NeoTalk TESTE: iniciando carregamento do modelo Whisper...');
  env.backends.onnx.wasm.proxy = false;
  transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base');
  console.log('NeoTalk TESTE: modelo carregado com sucesso!');
  return transcriber;
}

async function blobToWhisperInput(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext({ sampleRate: 16000 });
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  const channelData = audioBuffer.getChannelData(0);
  await audioContext.close();
  return channelData;
}

function downloadTranscriptTxt(): void {
  if (sessionTranscript.length === 0) return;

  const content = sessionTranscript.join('\n');
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `neotalk-transcricao-${Date.now()}.txt`;
  link.click();
}

async function processQueue(): Promise<void> {
  if (isProcessingQueue) return; // já tem alguém processando, não duplica
  if (transcriptionQueue.length === 0) return; // fila vazia, nada a fazer

  isProcessingQueue = true;
  const audioBlob = transcriptionQueue.shift()!; // pega o primeiro bloco da fila

  const transcribeStart = performance.now();
  try {
    const audioData = await blobToWhisperInput(audioBlob);
    // @ts-ignore — tipagem genérica do pipeline não reconhece o retorno específico de ASR
    const result = await transcriber!(audioData, {
      language: 'portuguese',
      task: 'transcribe',
      repetition_penalty: 1.3,
      no_repeat_ngram_size: 3
    });
    const texto = (result as { text: string }).text?.trim();
    const transcribeEnd = performance.now();
    console.log(`NeoTalk TIMING: transcrição durou ${(transcribeEnd - transcribeStart).toFixed(0)}ms | fila restante: ${transcriptionQueue.length}`);

    if (texto && texto.length > 0) {
      sessionTranscript.push(texto);
      console.log('NeoTalk TRANSCRIÇÃO ACUMULADA:', sessionTranscript.join(' '));
      chrome.runtime.sendMessage({ type: 'NEOTALK_TAB_AUDIO_TRANSCRIPT', frase: texto });
    }
  } catch (error) {
    console.error('NeoTalk: falha ao transcrever bloco da fila.', error);
  }

  isProcessingQueue = false;
  void processQueue(); // tenta processar o próximo item da fila, se houver
}

async function waitForQueueAndDownload(): Promise<void> {
  while (transcriptionQueue.length > 0 || isProcessingQueue) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  downloadTranscriptTxt();
}

function startContinuousRecording(mediaStream: MediaStream): void {
  const recorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm' });
  activeRecorder = recorder;
  let chunks: Blob[] = [];
  let recordStart = performance.now();

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  recorder.onstop = () => {
    const recordEnd = performance.now();
    console.log(`NeoTalk TIMING: bloco gravado em ${(recordEnd - recordStart).toFixed(0)}ms`);

    const audioBlob = new Blob(chunks, { type: 'audio/webm' });
    transcriptionQueue.push(audioBlob);
    void processQueue();

    if (isListening) {
      chunks = [];
      recordStart = performance.now();
      recorder.start();
      setTimeout(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, RECORD_CHUNK_MS);
    } else {
      mediaStream.getTracks().forEach((track) => track.stop());
      void waitForQueueAndDownload();
    }
  };

  recorder.start();
  setTimeout(() => {
    if (recorder.state !== 'inactive') recorder.stop();
  }, RECORD_CHUNK_MS);
}

function stopCapture(): void {
  isListening = false;
  if (activeRecorder && activeRecorder.state !== 'inactive') {
    activeRecorder.stop();
  }
  stream = null;
}

async function startCapture(streamId: string): Promise<void> {
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

    await ensureTranscriber();

    isListening = true;
    sessionTranscript = [];
    transcriptionQueue.length = 0; // limpa a fila de uma sessão anterior, se houver
    startContinuousRecording(stream);
  } catch (error) {
    await saveCaptionState({ status: '', error: MESSAGES.tabAudioUnsupported });
    await addDeveloperError(MESSAGES.tabAudioUnsupported, error);
    console.warn('NeoTalk: falha técnica ao capturar áudio da aba.', error);
  }
}
async function startMicrophoneCapture(): Promise<void> {
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream = micStream;

    await ensureTranscriber();

    isListening = true;
    sessionTranscript = [];
    transcriptionQueue.length = 0;
    startContinuousRecording(micStream);
  } catch (error) {
    await saveCaptionState({ status: '', error: MESSAGES.speechUnsupported });
    await addDeveloperError(MESSAGES.speechUnsupported, error);
    console.warn('NeoTalk: falha ao capturar microfone.', error);
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage) => {
  if (message.type === 'NEOTALK_OFFSCREEN_START') void startCapture(message.streamId);
  if (message.type === 'NEOTALK_OFFSCREEN_STOP') stopCapture();
  if (message.type === 'NEOTALK_OFFSCREEN_START_MIC') void startMicrophoneCapture();
  if (message.type === 'NEOTALK_OFFSCREEN_STOP_MIC') stopCapture();
});