import { pipeline, env } from '@xenova/transformers';
import { MICROPHONE_PERMISSION_REQUIRED, MICROPHONE_TIMEOUT } from '../shared/errors.js';
import { MESSAGES } from '../shared/messages.js';
import { normalizeTranscript } from '../shared/transcript.js';
import {
  addDeveloperError as addDeveloperErrorNow,
  saveAudioCaptureState as saveAudioCaptureStateNow,
  saveCaptionState as saveCaptionStateNow,
  saveSessionTranscript as saveSessionTranscriptNow
} from '../shared/storage.js';
import { getSpeechRecognitionConstructor } from '../shared/speech.js';
import type { SpeechRecognition, SpeechRecognitionEvent } from '../shared/speech.js';
import { withTimeout } from '../shared/timeout.js';
import type { AudioCaptureMode, CaptureResponse, RuntimeMessage } from '../shared/types.js';
import { SpeechSegmenter, rootMeanSquare } from './speech-segmenter.js';

const LEVEL_POLL_MS = 50;
const MAX_QUEUE_SIZE = 8;
/** getUserMedia() num documento offscreen pode travar sem nunca resolver nem
 * rejeitar, mesmo com a permissão já concedida (observado em campo). */
const GET_USER_MEDIA_TIMEOUT_MS = 8_000;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

const STORAGE_RETRY_ATTEMPTS = 8;
const STORAGE_RETRY_DELAY_MS = 500;

/**
 * `chrome.storage` não fica disponível instantaneamente num documento
 * offscreen recém-criado: mesmo com o listener de mensagens já registrado
 * (confirmado pelo PING) e `chrome.runtime` já funcionando, a primeira
 * chamada pode lançar "Cannot read properties of undefined (reading
 * 'local')" por uma janela breve, até a API terminar de ficar disponível —
 * confirmado tentando de novo até funcionar (em teste real, resolve em
 * poucas tentativas). Sem isto, a primeira gravação de estado de qualquer
 * captura (microfone ou transcrição do áudio da aba) podia falhar de forma
 * definitiva, mesmo a captura em si funcionando normalmente.
 */
async function withStorageRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < STORAGE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, STORAGE_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

function saveAudioCaptureState(...args: Parameters<typeof saveAudioCaptureStateNow>): ReturnType<typeof saveAudioCaptureStateNow> {
  return withStorageRetry(() => saveAudioCaptureStateNow(...args));
}
function saveCaptionState(...args: Parameters<typeof saveCaptionStateNow>): ReturnType<typeof saveCaptionStateNow> {
  return withStorageRetry(() => saveCaptionStateNow(...args));
}
function saveSessionTranscript(...args: Parameters<typeof saveSessionTranscriptNow>): ReturnType<typeof saveSessionTranscriptNow> {
  return withStorageRetry(() => saveSessionTranscriptNow(...args));
}
function addDeveloperError(...args: Parameters<typeof addDeveloperErrorNow>): ReturnType<typeof addDeveloperErrorNow> {
  return withStorageRetry(() => addDeveloperErrorNow(...args));
}

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
let loadingTranscriber: Promise<Transcriber> | null = null;
let activeSession: CaptureSession | null = null;
let pendingSessionId: string | null = null;

/**
 * Carrega o modelo sob demanda, sem bloquear quem está esperando por ele.
 * O progresso é publicado como `message`/`progress` em cima da fase atual
 * (normalmente `recording` ou `transcribing`) — a fase em si nunca muda por
 * causa do carregamento do modelo, para o botão não sair do vermelho
 * enquanto ele baixa (pode levar minutos na primeira vez).
 */
async function ensureTranscriber(mode: AudioCaptureMode, sessionId: string, phase: 'recording' | 'transcribing'): Promise<Transcriber> {
  if (transcriber) return transcriber;
  if (loadingTranscriber) return loadingTranscriber;

  loadingTranscriber = (async () => {
    // Mantido em `false` de propósito: com `proxy = true` o onnxruntime cria um
    // Worker a partir de blob URL, e a CSP da extensão (`script-src 'self'`)
    // bloqueia isso — a transcrição pararia por inteiro. O custo é a inferência
    // ocupar a thread do documento; quem sofria com isso era o PING que o
    // service worker manda antes de cada trecho, e esse caminho foi resolvido
    // lá (`waitForOffscreenReady`), sem mexer no threading.
    env.backends.onnx.wasm.proxy = false;
    await saveAudioCaptureState({ phase, mode, sessionId, message: 'Preparando transcrição…', progress: 0 });
    // `tiny` em vez de `base`: ~3x mais rápido, e a janela deslizante do áudio
    // da aba re-transcreve o mesmo trecho a cada ~1,2 s — sem essa margem, a
    // inferência não acompanha e as prévias seriam todas descartadas.
    const instance = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
      progress_callback: (data: { status?: string; progress?: number }) => {
        if (data.status !== 'progress' || typeof data.progress !== 'number') return;
        void saveAudioCaptureState({
          phase, mode, sessionId,
          message: `Baixando modelo de transcrição… ${Math.round(data.progress)}%`,
          progress: data.progress
        });
      }
    });
    transcriber = instance as Transcriber;
    loadingTranscriber = null;
    return transcriber;
  })();

  return loadingTranscriber;
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

async function checkMicrophonePermission(): Promise<PermissionState | 'unknown'> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as any });
    return status.state;
  } catch {
    return 'unknown';
  }
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
        const model = await ensureTranscriber(session.mode, session.id, 'transcribing');
        const audioData = await blobToWhisperInput(audioBlob);
        // @ts-expect-error A tipagem genérica do pipeline não descreve o retorno específico de ASR.
        const result = await model(audioData, { language: 'portuguese', task: 'transcribe', repetition_penalty: 1.3, no_repeat_ngram_size: 3 });
        const previousText = session.transcript.join(' ');
        const text = normalizeTranscript((result as { text?: string }).text ?? '', previousText);
        if (text) {
          session.transcript.push(text);
          session.sequence += 1;
          console.log(`NeoTalk [${session.mode} FINAL]`, text);
          void chrome.runtime.sendMessage({ type: 'NEOTALK_TAB_AUDIO_TRANSCRIPT', frase: text, sessionId: session.id, sequence: session.sequence, mode: session.mode, partial: false } satisfies RuntimeMessage);
        }
      } catch (error) {
        await addDeveloperError('Não foi possível transcrever um bloco de áudio.', error);
        await saveCaptionState({ status: '', error: MESSAGES.chunkTranscriptionFailed });
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
      // O modelo pode ainda estar carregando (só acontece na primeira vez,
      // pode levar minutos); descarta o trecho mais antigo em vez de
      // encerrar a captura enquanto isso.
      if (session.queue.length >= MAX_QUEUE_SIZE) session.queue.shift();
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

/**
 * Abre o stream e começa a gravar sem esperar o modelo de transcrição —
 * ele só é necessário para transcrever, não para capturar. `recording` é
 * atingido assim que o stream e o gravador estão prontos; o carregamento
 * do modelo acontece em paralelo, na primeira vez que há algo para
 * transcrever (dentro de `processQueue`).
 */
async function startWithStream(mode: AudioCaptureMode, streamFactory: () => Promise<MediaStream>): Promise<void> {
  await stopActiveSession();
  // Uma captura por vez, nos dois sentidos: o microfone agora vive fora de
  // `activeSession` (é Web Speech, não MediaRecorder), então precisa ser
  // encerrado explicitamente aqui.
  await stopMicrophoneSession();
  const pendingId = crypto.randomUUID();
  pendingSessionId = pendingId;
  await saveAudioCaptureState({ phase: 'starting', mode, sessionId: pendingId });
  const stream = await streamFactory();
  try {
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

/**
 * Microfone: transcrição ao vivo pela Web Speech API.
 *
 * O Whisper só devolve texto quando termina de processar um bloco inteiro, e
 * o bloco só fecha na pausa da fala — quem falava sem parar não via nada por
 * até 20 segundos. A Web Speech API entrega resultado parcial a cada ~200 ms:
 * o texto aparece palavra a palavra e vai se corrigindo até a frase fechar.
 *
 * Só vale para o microfone. Ela sempre escuta o dispositivo padrão do sistema
 * e não aceita um `MediaStream`, então o áudio da aba continua no Whisper.
 */
type MicrophoneSession = {
  id: string;
  recognition: SpeechRecognition;
  /**
   * A Web Speech API abre o microfone por conta própria e não usa este stream
   * para nada. Ele existe por dois outros motivos, ver `startMicrophoneCapture`.
   */
  stream: MediaStream;
  listening: boolean;
  sequence: number;
  transcript: string[];
};

let micSession: MicrophoneSession | null = null;

function sendTranscript(sessionId: string, frase: string, sequence: number, partial: boolean): void {
  console.log(`NeoTalk [microfone ${partial ? 'parcial' : 'FINAL'}]`, frase);
  void chrome.runtime.sendMessage({
    type: 'NEOTALK_TAB_AUDIO_TRANSCRIPT', frase, sessionId, sequence, mode: 'microphone', partial
  } satisfies RuntimeMessage);
}

function handleRecognitionResult(session: MicrophoneSession, event: SpeechRecognitionEvent): void {
  if (micSession?.id !== session.id) return;

  let interim = '';
  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index];
    const raw = result[0]?.transcript ?? '';
    if (!result.isFinal) {
      interim += raw;
      continue;
    }
    // `normalizeTranscript` só no texto confirmado: o parcial ainda vai mudar,
    // e limpar sobreposição de algo que será reescrito é trabalho jogado fora.
    const text = normalizeTranscript(raw, session.transcript.join(' '));
    if (!text) continue;
    session.transcript.push(text);
    session.sequence += 1;
    sendTranscript(session.id, text, session.sequence, false);
  }

  const preview = interim.trim();
  // Sequência não avança no parcial: ele substitui a prévia anterior em vez de
  // virar mais um trecho, e o service worker o descarta quando o final chega.
  if (preview) sendTranscript(session.id, preview, session.sequence, true);
}

async function stopMicrophoneSession(): Promise<void> {
  const session = micSession;
  if (!session) return;
  session.listening = false;
  micSession = null;
  await saveAudioCaptureState({ phase: 'stopping', mode: 'microphone', sessionId: session.id });
  try {
    session.recognition.stop();
  } catch {
    // Reconhecedor já encerrado por conta própria: nada a fazer.
  }
  // Solta o microfone: sem isto o indicador de gravação do Chrome fica aceso na
  // aba mesmo depois de parar, e a razão USER_MEDIA seguiria em uso à toa.
  session.stream.getTracks().forEach((track) => track.stop());
  await saveSessionTranscript(session.transcript.join(' '));
  await saveAudioCaptureState({ phase: 'inactive' });
}

function startMicrophoneCapture(): Promise<void> {
  // O prazo cobre a partida inteira, não só um passo: gravar estado num
  // documento offscreen já é, sozinho, um ponto onde a promessa pode nunca
  // resolver (observado em campo) — sem um limite ao redor de tudo, o botão
  // fica preso em "Preparando..." para sempre, mesmo com permissão concedida.
  return withTimeout((async () => {
    // Uma captura por vez: encerra o áudio da aba (Whisper) se estiver ativo.
    await stopActiveSession();
    await stopMicrophoneSession();

    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) throw new Error(MESSAGES.speechUnsupported);

    // O documento offscreen é invisível: o Chrome nunca mostra o prompt de
    // permissão aqui. Sem a permissão já concedida (via página de opções), o
    // reconhecedor falharia de forma opaca — melhor identificar a causa antes
    // e deixar quem chamou levar o usuário até lá.
    const permission = await checkMicrophonePermission();
    if (permission === 'denied' || permission === 'prompt') throw new Error(MICROPHONE_PERMISSION_REQUIRED);

    const id = crypto.randomUUID();
    await saveAudioCaptureState({ phase: 'starting', mode: 'microphone', sessionId: id });

    // Abrir o microfone e MANTER o stream vivo durante a sessão, mesmo sem a Web
    // Speech precisar dele. Dois motivos:
    //
    // 1. O documento offscreen foi criado com `reasons: [USER_MEDIA,
    //    AUDIO_PLAYBACK]`. Só o `SpeechRecognition` não exerce nenhuma das duas,
    //    e um documento cuja razão não está em uso pode ser recolhido pelo
    //    Chrome no meio da sessão — a captura morreria sem erro visível.
    // 2. É o contorno conhecido para o `not-allowed` quando a Web Speech roda
    //    num contexto que nunca abriu o microfone.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const recognition = new Recognition();
    recognition.lang = 'pt-BR';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    const session: MicrophoneSession = { id, recognition, stream, listening: true, sequence: 0, transcript: [] };
    micSession = session;

    recognition.onresult = (event) => handleRecognitionResult(session, event);
    recognition.onerror = (event) => {
      // 'no-speech' e 'aborted' são rotina: o Chrome encerra sozinho depois de
      // um tempo em silêncio e o `onend` abaixo religa. Só o resto é falha.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      console.warn('NeoTalk: falha no reconhecimento de voz.', event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        session.listening = false;
        void saveCaptionState({ status: '', error: MESSAGES.microphonePermissionRequired });
      }
      void addDeveloperError('Falha no reconhecimento de voz do microfone.', event.error);
    };
    // O reconhecedor para sozinho em silêncio prolongado, mesmo com
    // `continuous`. Religar mantém a captura viva até o usuário mandar parar.
    recognition.onend = () => {
      if (!session.listening || micSession?.id !== session.id) return;
      try {
        recognition.start();
      } catch {
        // Corrida com um stop() em andamento: a sessão já está encerrando.
      }
    };

    recognition.start();
    await saveSessionTranscript('');
    await saveAudioCaptureState({ phase: 'recording', mode: 'microphone', sessionId: id, queueSize: 0 });
  })(), GET_USER_MEDIA_TIMEOUT_MS, MICROPHONE_TIMEOUT);
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

/**
 * Transcreve um trecho recebido de fora (do balão, via captureStream na
 * própria página), sem sessão de captura própria — quem grava é o content
 * script; o offscreen só empresta o modelo já carregado.
 */
async function transcribeChunkNow(audioBase64: string, mimeType: string): Promise<string> {
  const blob = base64ToBlob(audioBase64, mimeType);
  const audioData = await blobToWhisperInput(blob);
  const model = await ensureTranscriber('tab', 'page-audio', activeSession ? 'transcribing' : 'recording');
  // @ts-expect-error A tipagem genérica do pipeline não descreve o retorno específico de ASR.
  const result = await model(audioData, { language: 'portuguese', task: 'transcribe', repetition_penalty: 1.3, no_repeat_ngram_size: 3 });
  return normalizeTranscript((result as { text?: string }).text ?? '', '');
}

/**
 * Um trecho de cada vez, na ordem de chegada — mesmo padrão que o microfone
 * já usa (`processQueue`/`session.queue`, acima). Sem isto, dois trechos do
 * áudio da aba podiam transcrever em paralelo e terminar fora de ordem (um
 * mais curto ultrapassando um mais longo); o service worker então descartava
 * o atrasado, por sua checagem de sequência estritamente crescente.
 */
let transcribeChunkChain: Promise<string> = Promise.resolve('');

function transcribeChunk(audioBase64: string, mimeType: string): Promise<string> {
  const next = transcribeChunkChain.then(
    () => transcribeChunkNow(audioBase64, mimeType),
    () => transcribeChunkNow(audioBase64, mimeType)
  );
  // Uma falha não pode travar a fila para os próximos trechos.
  transcribeChunkChain = next.catch(() => '');
  return next;
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (!message.type.startsWith('NEOTALK_OFFSCREEN_')) return false;

  if (message.type === 'NEOTALK_OFFSCREEN_PING') {
    sendResponse({ ok: true } satisfies CaptureResponse);
    return false;
  }

  void (async () => {
    try {
      if (message.type === 'NEOTALK_OFFSCREEN_START') await startTabCapture(message.streamId);
      if (message.type === 'NEOTALK_OFFSCREEN_START_MIC') await startMicrophoneCapture();
      if (message.type === 'NEOTALK_OFFSCREEN_STOP_MIC') await stopMicrophoneSession();
      if (message.type === 'NEOTALK_OFFSCREEN_STOP') await stopActiveSession();
      if (message.type === 'NEOTALK_OFFSCREEN_TRANSCRIBE_CHUNK') {
        const text = await transcribeChunk(message.audioBase64, message.mimeType);
        sendResponse({ ok: true, text });
        return;
      }
      sendResponse({ ok: true } satisfies CaptureResponse);
    } catch (error) {
      if (error instanceof Error && error.message === MICROPHONE_PERMISSION_REQUIRED) {
        sendResponse({ ok: false, error: MICROPHONE_PERMISSION_REQUIRED } satisfies CaptureResponse);
        return;
      }
      const fallback = message.type.includes('MIC') ? MESSAGES.speechUnsupported : MESSAGES.tabAudioUnsupported;
      const detail = error instanceof Error ? error.message : fallback;
      // A resposta sai IMEDIATAMENTE — quem espera do outro lado (o service
      // worker, sem timeout no comando real) não pode ficar refém de uma
      // gravação de estado que também pode travar. Foi exatamente essa
      // ordem (gravar antes de responder) que, junto com o `getUserMedia`
      // sem prazo, mantinha o botão preso para sempre mesmo depois de um
      // erro real acontecer.
      sendResponse({ ok: false, error: detail } satisfies CaptureResponse);
      // Depois da resposta, gravar o estado é best-effort: um documento com o
      // contexto realmente inválido (por exemplo, duas capturas que ficaram
      // brigando pelo mesmo documento) não tem como se recuperar mesmo
      // assim — não faz sentido deixar isso virar mais um "Uncaught (in
      // promise)" sem tratamento no console.
      if (message.type !== 'NEOTALK_OFFSCREEN_TRANSCRIBE_CHUNK') {
        void saveAudioCaptureState({ phase: 'error', message: detail }).catch(() => undefined);
        void saveCaptionState({ status: '', error: fallback }).catch(() => undefined);
      }
      void addDeveloperError(fallback, error).catch(() => undefined);
    }
  })();
  return true;
});
