/**
 * Captura o áudio da aba direto na página, via `captureStream()` num
 * elemento `<video>`/`<audio>` tocando.
 *
 * `chrome.tabCapture` exige que a extensão tenha sido invocada pela UI
 * nativa do Chrome (ícone, menu de contexto, atalho) — um clique num botão
 * injetado pelo content script não conta, e a captura falha com "Extension
 * has not been invoked for the current page". `captureStream()` não tem
 * essa exigência: funciona com um clique comum, direto no balão.
 *
 * Limitação aceita: não funciona em conteúdo com DRM (Netflix, por exemplo)
 * nem em áudio tocado só via Web Audio API sem elemento de mídia associado.
 * Nesses casos, `startPageAudioCapture` devolve `NO_MEDIA_ELEMENT`, e o
 * balão orienta a usar o popup da extensão (que mantém o caminho antigo,
 * via `tabCapture`, disponível como alternativa).
 */
import { SpeechSegmenter, rootMeanSquare } from '../offscreen/speech-segmenter.js';
import { NO_MEDIA_ELEMENT } from '../shared/errors.js';
import { MESSAGES } from '../shared/messages.js';
import { saveAudioCaptureState, saveCaptionState, saveSessionTranscript } from '../shared/storage.js';
import type { PageAudioChunkMessage } from '../shared/types.js';
import { blobToBase64, isEligibleMediaElement, pickLiveAudioTracks } from './page-audio-utils.js';

const LEVEL_POLL_MS = 50;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
/** De quanto em quanto tempo o gravador entrega um pedaço do trecho aberto. */
const RECORDER_TIMESLICE_MS = 250;
/** Intervalo entre prévias do trecho ainda aberto. */
const PARTIAL_INTERVAL_MS = 1_200;

type PageAudioSession = {
  id: string;
  stream: MediaStream;
  recorder: MediaRecorder;
  audioContext: AudioContext;
  audioSource: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  /** Saída de áudio puro que o MediaRecorder grava — as faixas daqui são nossas. */
  destination: MediaStreamAudioDestinationNode;
  segmenter: SpeechSegmenter;
  discard: { next: boolean };
  levelTimer?: number;
  partialTimer?: number;
  sequence: number;
  listening: boolean;
  /** Pedaços do trecho em curso, para a prévia poder ser montada a qualquer momento. */
  chunks: Blob[];
  /** Uma prévia por vez: as atrasadas são puladas, nunca enfileiradas. */
  partialInFlight: boolean;
};

let activeSession: PageAudioSession | null = null;

function selectMimeType(): string {
  const mimeType = MIME_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  if (!mimeType) throw new Error('Nenhum formato de gravação compatível foi encontrado.');
  return mimeType;
}

/** Primeiro elemento de mídia tocando com áudio audível. */
function findAudibleMediaElement(): HTMLMediaElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio'));
  return candidates.find(isEligibleMediaElement) ?? null;
}

function watchLevel(session: PageAudioSession): void {
  const samples = new Float32Array(session.analyser.fftSize);
  session.levelTimer = window.setInterval(() => {
    session.analyser.getFloatTimeDomainData(samples);
    session.segmenter.push(rootMeanSquare(samples), performance.now());
  }, LEVEL_POLL_MS);
}

/**
 * A promessa devolvida só resolve quando a transcrição daquele trecho VOLTA, não
 * quando a mensagem sai. É disso que depende a trava `partialInFlight` em
 * `watchPartials`: antes o `sendMessage` era disparado com `void`, a promessa
 * resolvia logo após o base64, e a trava caía em milissegundos — as prévias
 * saíam a cada 1,2 s independente da inferência anterior ter terminado, a fila
 * do offscreen crescia sem limite e o trecho definitivo ficava preso atrás de
 * prévias já obsoletas. Exatamente o empilhamento que a trava existe para evitar.
 */
async function sendChunk(session: PageAudioSession, blob: Blob, sequence: number, partial: boolean): Promise<void> {
  const audioBase64 = await blobToBase64(blob);
  const message: PageAudioChunkMessage = {
    type: 'NEOTALK_PAGE_AUDIO_CHUNK',
    sessionId: session.id,
    sequence,
    audioBase64,
    mimeType: session.recorder.mimeType,
    partial
  };
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // Contexto da extensão invalidado (recarregada com a aba aberta): sem o
    // catch isto viraria "Uncaught (in promise)" no console da página, por cima
    // do aviso real. Quem cuida de encerrar a sessão é o `pagehide`.
  }
}

/**
 * Manda o trecho ainda aberto para transcrever, sem esperar ele fechar.
 *
 * O Whisper não tem streaming: só devolve texto ao terminar o bloco, e o bloco
 * só fechava na pausa da fala — num áudio corrido, isso era até 20 s sem nada
 * na tela. Aqui o mesmo trecho é reenviado a cada ~1,2 s, sempre maior, e o
 * texto na tela é substituído pela versão nova: cresce e se corrige enquanto o
 * áudio toca.
 *
 * Concatenar sempre a partir do primeiro pedaço preserva o cabeçalho do webm,
 * então o blob parcial é decodificável — um pedaço solto do meio não seria.
 */
function watchPartials(session: PageAudioSession): void {
  session.partialTimer = window.setInterval(() => {
    if (activeSession?.id !== session.id || !session.listening) return;
    // Prévia anterior ainda rodando: pular. Elas são descartáveis por
    // natureza — enfileirar só acumularia atraso sobre o texto definitivo.
    if (session.partialInFlight) return;
    if (session.chunks.length === 0 || !session.segmenter.speaking) return;

    const blob = new Blob(session.chunks, { type: session.recorder.mimeType });
    if (blob.size === 0) return;
    session.partialInFlight = true;
    void sendChunk(session, blob, session.sequence + 1, true).finally(() => {
      session.partialInFlight = false;
    });
  }, PARTIAL_INTERVAL_MS);
}

function configureRecorder(session: PageAudioSession): void {
  session.recorder.ondataavailable = (event) => {
    if (event.data.size > 0) session.chunks.push(event.data);
  };
  session.recorder.onstop = () => {
    const blob = new Blob(session.chunks, { type: session.recorder.mimeType });
    session.chunks = [];
    const discarded = session.discard.next;
    session.discard.next = false;

    if (blob.size > 0 && !discarded) {
      session.sequence += 1;
      void sendChunk(session, blob, session.sequence, false);
    }

    if (session.listening && activeSession?.id === session.id) {
      session.recorder.start(RECORDER_TIMESLICE_MS);
      session.segmenter.reset(performance.now());
    }
  };
}

function teardown(session: PageAudioSession): void {
  window.clearInterval(session.levelTimer);
  window.clearInterval(session.partialTimer);
  // Entrega o que já foi falado antes de encerrar.
  session.segmenter.end(performance.now());
  if (session.recorder.state === 'recording') session.recorder.stop();
  // Paramos apenas as faixas que criamos. O Chrome devolve o MESMO MediaStream a
  // cada `captureStream()` do mesmo elemento: encerrar as faixas dele as deixaria
  // `ended` para sempre, e a próxima captura nesta página já nasceria quebrada.
  session.destination.stream.getTracks().forEach((track) => track.stop());
  session.audioSource.disconnect();
  session.analyser.disconnect();
  session.destination.disconnect();
  void session.audioContext.close();
}

export async function startPageAudioCapture(tabId: number | null): Promise<{ ok: boolean; error?: string }> {
  if (activeSession) await stopPageAudioCapture();

  const element = findAudibleMediaElement();
  if (!element) return { ok: false, error: NO_MEDIA_ELEMENT };

  let stream: MediaStream;
  try {
    if (!element.captureStream) return { ok: false, error: NO_MEDIA_ELEMENT };
    stream = element.captureStream();
  } catch {
    return { ok: false, error: NO_MEDIA_ELEMENT };
  }
  const liveTracks = pickLiveAudioTracks(stream.getAudioTracks());
  if (liveTracks.length === 0) return { ok: false, error: NO_MEDIA_ELEMENT };

  const sessionId = crypto.randomUUID();
  await saveAudioCaptureState({ phase: 'starting', mode: 'tab', tabId: tabId ?? undefined, sessionId });

  try {
    const audioContext = new AudioContext();
    // Só as faixas de áudio. `captureStream()` num <video> devolve áudio E vídeo,
    // e o MediaRecorder aqui usa contêiner de áudio puro (audio/webm): com uma
    // faixa de vídeo junto, `start()` falha com "There was an error starting the
    // MediaRecorder" — era exatamente o erro que o balão mostrava.
    const audioSource = audioContext.createMediaStreamSource(new MediaStream(liveTracks));
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    const destination = audioContext.createMediaStreamDestination();
    audioSource.connect(analyser);
    analyser.connect(destination);
    // Sem conectar em `audioContext.destination`: ao contrário de tabCapture,
    // `captureStream()` não silencia a página, então reencaminhar duplicaria o som.

    const discard = { next: false };
    const recorder = new MediaRecorder(destination.stream, { mimeType: selectMimeType() });
    const segmenter = new SpeechSegmenter((hadSpeech) => {
      discard.next = !hadSpeech;
      if (recorder.state === 'recording') recorder.stop();
    });

    const session: PageAudioSession = { id: sessionId, stream, recorder, audioContext, audioSource, analyser, destination, segmenter, discard, sequence: 0, listening: true, chunks: [], partialInFlight: false };
    configureRecorder(session);
    activeSession = session;

    // Com `timeslice`, o gravador entrega pedaços durante a gravação em vez de
    // só no `stop()` — é o que permite montar a prévia do trecho ainda aberto.
    recorder.start(RECORDER_TIMESLICE_MS);
    segmenter.reset(performance.now());
    watchLevel(session);
    watchPartials(session);
    // Vídeo que termina não pode deixar o botão vermelho gravando silêncio.
    liveTracks.forEach((track) => track.addEventListener('ended', () => {
      if (activeSession?.id === sessionId) void stopPageAudioCapture();
    }));

    await saveSessionTranscript('');
    await saveCaptionState({ caption: '', status: MESSAGES.listening, error: undefined });
    await saveAudioCaptureState({ phase: 'recording', mode: 'tab', tabId: tabId ?? undefined, sessionId });
    return { ok: true };
  } catch (error) {
    // Não encerramos as faixas do elemento aqui: elas pertencem à página, e
    // pará-las impediria qualquer nova tentativa de captura (ver `teardown`).
    const detail = error instanceof Error ? error.message : 'page-audio-start-failed';
    await saveAudioCaptureState({ phase: 'error', mode: 'tab', tabId: tabId ?? undefined, message: MESSAGES.tabAudioStartFailed });
    await saveCaptionState({ status: '', error: MESSAGES.tabAudioStartFailed });
    return { ok: false, error: detail };
  }
}

export async function stopPageAudioCapture(): Promise<void> {
  const session = activeSession;
  if (!session) {
    await saveAudioCaptureState({ phase: 'inactive' });
    return;
  }
  session.listening = false;
  activeSession = null;
  await saveAudioCaptureState({ phase: 'stopping', mode: 'tab', sessionId: session.id });
  teardown(session);
  await saveAudioCaptureState({ phase: 'inactive' });
}

export function isPageAudioActive(): boolean {
  return activeSession !== null;
}

// Navegar para fora da página não pode deixar um MediaRecorder órfão gravando.
// A checagem por `window` permite importar as funções puras deste módulo em
// testes Node, sem um DOM de verdade.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (activeSession) void stopPageAudioCapture();
  });
}
