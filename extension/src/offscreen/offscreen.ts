import { pipeline, env } from '@xenova/transformers';
import { MESSAGES } from '../shared/messages.js';
import { normalizeTranscript } from '../shared/transcript.js';
import { addDeveloperError, saveAudioCaptureState, saveCaptionState, saveSessionTranscript } from '../shared/storage.js';
import type { AudioCaptureMode, CaptureResponse, RuntimeMessage } from '../shared/types.js';
import { SpeechSegmenter, rootMeanSquare } from './speech-segmenter.js';

const LEVEL_POLL_MS = 50;
const MAX_QUEUE_SIZE = 8;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

type Transcriber = Awaited<ReturnType<typeof pipeline>>;
type CaptureSession = {
  id: string;
  mode: AudioCaptureMode;
  stream: MediaStream;
  recorder: MediaRecorder;
  queue: Blob[];
  transcript: string[];
  sequence: number;
  processing: boolean;
  listening: boolean;
  segmenter: SpeechSegmenter;
  /** Marcado pelo segmentador quando o trecho gravado nao contem fala. */
  discard: { next: boolean };
  levelTimer?: number;
  audioContext?: AudioContext;
  audioSource?: MediaStreamAudioSourceNode;
  analyser?: AnalyserNode;
};

let transcriber: Transcriber | null = null;
let activeSession: CaptureSession | null = null;
let pendingSessionId: string | null = null;

async function ensureTranscriber(mode: AudioCaptureMode, sessionId: string): Promise<Transcriber> {
  if (transcriber) return transcriber;
  await saveAudioCaptureState({ phase: 'loading-model', mode, sessionId, message: 'Carregando o modelo de transcrição…' });
  env.backends.onnx.wasm.proxy = false;
  transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base');
  return transcriber;
}

async function blobToWhisperInput(blob: Blob): Promise<Float32Array> {
  const audioContext = new AudioContext({ sampleRate: 16_000 });
  try {
    const audioBuffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    return audioBuffer.getChannelData(0);
  } finally {
    await audioContext.close();
  }
}

function selectMimeType(): string {
  const mimeType = MIME_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  if (!mimeType) throw new Error('Nenhum formato de gravação compatível foi encontrado.');
  return mimeType;
}

async function processQueue(session: CaptureSession): Promise<void> {
  if (session.processing) return;
  session.processing = true;
  try {
    while (session.queue.length > 0) {
      const audioBlob = session.queue.shift();
      if (!audioBlob) continue;
      await saveAudioCaptureState({ phase: 'transcribing', mode: session.mode, sessionId: session.id, queueSize: session.queue.length });
      try {
        const model = await ensureTranscriber(session.mode, session.id);
        const audioData = await blobToWhisperInput(audioBlob);
        // @ts-expect-error A tipagem genérica do pipeline não descreve o retorno específico de ASR.
        const result = await model(audioData, { language: 'portuguese', task: 'transcribe', repetition_penalty: 1.3, no_repeat_ngram_size: 3 });
        const previousText = session.transcript.join(' ');
        const text = normalizeTranscript((result as { text?: string }).text ?? '', previousText);
        if (text) {
          session.transcript.push(text);
          session.sequence += 1;
          void chrome.runtime.sendMessage({ type: 'NEOTALK_TAB_AUDIO_TRANSCRIPT', frase: text, sessionId: session.id, sequence: session.sequence, mode: session.mode } satisfies RuntimeMessage);
        }
      } catch (error) {
        await addDeveloperError('Não foi possível transcrever um bloco de áudio.', error);
        await saveCaptionState({ status: '', error: 'Um trecho do áudio não pôde ser transcrito.' });
      }
    }
  } finally {
    session.processing = false;
    if (session.listening && activeSession?.id === session.id) {
      await saveAudioCaptureState({ phase: 'recording', mode: session.mode, sessionId: session.id, queueSize: 0 });
    }
  }
}

/**
 * Mede a energia do sinal e deixa o segmentador decidir onde cortar. O
 * AnalyserNode substitui o ScriptProcessorNode, que esta obsoleto.
 */
function watchAudioLevel(session: CaptureSession): void {
  const analyser = session.analyser;
  if (!analyser) return;
  const samples = new Float32Array(analyser.fftSize);
  session.levelTimer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    session.segmenter.push(rootMeanSquare(samples), performance.now());
  }, LEVEL_POLL_MS);
}

function configureRecorder(session: CaptureSession): void {
  let chunks: Blob[] = [];
  session.recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  session.recorder.onerror = () => void finishSession(session, 'Falha durante a gravação do áudio.');
  session.recorder.onstop = () => {
    const blob = new Blob(chunks, { type: session.recorder.mimeType });
    chunks = [];
    const discarded = session.discard.next;
    session.discard.next = false;
    if (blob.size > 0 && !discarded) {
      if (session.queue.length >= MAX_QUEUE_SIZE) {
        void finishSession(session, 'A transcrição não acompanhou a gravação. A captura foi interrompida para proteger a memória.');
        return;
      }
      session.queue.push(blob);
      void processQueue(session);
    }
    if (session.listening && activeSession?.id === session.id) {
      session.recorder.start();
      session.segmenter.reset(performance.now());
    }
  };
}

async function finishSession(session: CaptureSession, error?: string): Promise<void> {
  session.listening = false;
  window.clearInterval(session.levelTimer);
  // Entrega o que ja foi falado antes de encerrar.
  session.segmenter.end(performance.now());
  if (session.recorder.state === 'recording') session.recorder.stop();
  session.stream.getTracks().forEach((track) => track.stop());
  session.audioSource?.disconnect();
  session.analyser?.disconnect();
  if (session.audioContext && session.audioContext.state !== 'closed') await session.audioContext.close();
  while (session.processing || session.queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 100));
  await saveSessionTranscript(session.transcript.join(' '));
  if (activeSession?.id === session.id) activeSession = null;
  await saveAudioCaptureState(error ? { phase: 'error', mode: session.mode, message: error } : { phase: 'inactive' });
  if (error) {
    await saveCaptionState({ status: '', error });
    await addDeveloperError(error);
  }
}

async function stopActiveSession(): Promise<void> {
  pendingSessionId = null;
  if (!activeSession) {
    await saveAudioCaptureState({ phase: 'inactive' });
    return;
  }
  const session = activeSession;
  await saveAudioCaptureState({ phase: 'stopping', mode: session.mode, sessionId: session.id });
  await finishSession(session);
}

async function createSession(mode: AudioCaptureMode, stream: MediaStream): Promise<CaptureSession> {
  const recorder = new MediaRecorder(stream, { mimeType: selectMimeType() });
  const discard = { next: false };
  const segmenter = new SpeechSegmenter((hadSpeech) => {
    discard.next = !hadSpeech;
    if (recorder.state === 'recording') recorder.stop();
  });
  const session: CaptureSession = {
    id: crypto.randomUUID(), mode, stream, recorder,
    queue: [], transcript: [], sequence: 0, processing: false, listening: true,
    discard, segmenter
  };

  session.audioContext = new AudioContext();
  session.audioSource = session.audioContext.createMediaStreamSource(stream);
  session.analyser = session.audioContext.createAnalyser();
  session.analyser.fftSize = 2048;
  session.audioSource.connect(session.analyser);
  // tabCapture silencia a aba original; reencaminhar devolve o som ao usuario.
  if (mode === 'tab') session.audioSource.connect(session.audioContext.destination);

  configureRecorder(session);
  return session;
}

async function startWithStream(mode: AudioCaptureMode, streamFactory: () => Promise<MediaStream>): Promise<void> {
  await stopActiveSession();
  const pendingId = crypto.randomUUID();
  pendingSessionId = pendingId;
  await saveAudioCaptureState({ phase: 'starting', mode, sessionId: pendingId });
  const stream = await streamFactory();
  try {
    await ensureTranscriber(mode, pendingId);
    if (pendingSessionId !== pendingId) throw new Error('A inicialização da captura foi substituída por outra solicitação.');
    const session = await createSession(mode, stream);
    activeSession = session;
    pendingSessionId = null;
    session.recorder.start();
    session.segmenter.reset(performance.now());
    watchAudioLevel(session);
    await saveSessionTranscript('');
    await saveAudioCaptureState({ phase: 'recording', mode, sessionId: session.id, queueSize: 0 });
  } catch (error) {
    if (pendingSessionId === pendingId) pendingSessionId = null;
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
}

function startTabCapture(streamId: string): Promise<void> {
  return startWithStream('tab', () => navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as MediaTrackConstraints,
    video: false
  }));
}

function startMicrophoneCapture(): Promise<void> {
  return startWithStream('microphone', () => navigator.mediaDevices.getUserMedia({ audio: true, video: false }));
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (!message.type.startsWith('NEOTALK_OFFSCREEN_')) return false;
  void (async () => {
    try {
      if (message.type === 'NEOTALK_OFFSCREEN_START') await startTabCapture(message.streamId);
      if (message.type === 'NEOTALK_OFFSCREEN_START_MIC') await startMicrophoneCapture();
      if (message.type === 'NEOTALK_OFFSCREEN_STOP' || message.type === 'NEOTALK_OFFSCREEN_STOP_MIC') await stopActiveSession();
      sendResponse({ ok: true } satisfies CaptureResponse);
    } catch (error) {
      const fallback = message.type.includes('MIC') ? MESSAGES.speechUnsupported : MESSAGES.tabAudioUnsupported;
      const detail = error instanceof Error ? error.message : fallback;
      await saveAudioCaptureState({ phase: 'error', message: detail });
      await saveCaptionState({ status: '', error: fallback });
      await addDeveloperError(fallback, error);
      sendResponse({ ok: false, error: detail } satisfies CaptureResponse);
    }
  })();
  return true;
});
