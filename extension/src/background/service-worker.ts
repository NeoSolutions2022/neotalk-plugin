import { submitPhrase } from '../shared/api.js';
import { MESSAGES } from '../shared/messages.js';
import { conflictingMode, shouldIgnoreStart, shouldIgnoreStop } from '../shared/capture-guard.js';
import { MICROPHONE_PERMISSION_REQUIRED, MICROPHONE_TIMEOUT, NO_MEDIA_ELEMENT } from '../shared/errors.js';
import { withTimeout } from '../shared/timeout.js';
import { sanitizePhrase } from '../shared/text.js';
import { addDeveloperError, getAudioCaptureState, migrateStoredApiKey, saveAudioCaptureState, saveCaptionState, saveSelectedText } from '../shared/storage.js';
import type { AudioCaptureMode, CaptureResponse, PageAudioChunkMessage, RuntimeMessage } from '../shared/types.js';

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';
const RESTRICTED_URL = /^(chrome|edge|about|devtools|chrome-extension):/;
const RESTRICTED_PAGE_MESSAGE = 'Esta página não permite captura de áudio pelo navegador.';

/** Serializa os pedidos para dois cliques rapidos nao se atropelarem. */
let captureChain: Promise<CaptureResponse> = Promise.resolve({ ok: true });

function queueCapture(operation: () => Promise<CaptureResponse>): Promise<CaptureResponse> {
  const next = captureChain.then(operation, operation);
  captureChain = next.catch(() => ({ ok: false }));
  return next;
}

/**
 * `handlePageAudioChunk` chama isto a cada trecho de fala — sem essa trava,
 * dois trechos próximos (comum ao falar mais de uma frase: o corte por
 * pausa gera um a cada 1-2s, e o Whisper carregando/rodando leva bem mais
 * que isso) checavam "existe documento?" ao mesmo tempo, viam que não, e
 * AMBOS chamavam `createDocument()`. O Chrome só permite um documento
 * offscreen por vez — essa segunda criação concorrente invalidava o
 * primeiro documento no meio do processamento do trecho anterior, matando
 * a transcrição em andamento (é a origem do "Cannot read properties of
 * undefined (reading 'local')" dentro do offscreen: o contexto morreu com
 * um `await` ainda pendente). Compartilhar a mesma promessa entre chamadas
 * concorrentes garante uma criação só — mesmo padrão já usado por
 * `loadingTranscriber` em `offscreen.ts` para não carregar o modelo duas
 * vezes.
 */
let ensureOffscreenPromise: Promise<void> | null = null;

function ensureOffscreenDocument(): Promise<void> {
  if (!ensureOffscreenPromise) {
    ensureOffscreenPromise = (async () => {
      if (!chrome.offscreen?.createDocument) throw new Error('offscreen-unavailable');

      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
      });

      if (existingContexts.length > 0) return;

      // Documento novo: o listener dele ainda não subiu, então o handshake
      // precisa acontecer de novo antes do próximo comando.
      offscreenReady = false;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: 'Transcrever áudio da aba atual para tradução em Libras.'
      });
    })().finally(() => {
      ensureOffscreenPromise = null;
    });
  }
  return ensureOffscreenPromise;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
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

function sendExtensionMessage(message: RuntimeMessage): Promise<CaptureResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: CaptureResponse | undefined) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response ?? { ok: false, error: 'O documento de áudio não respondeu.' });
    });
  });
}

const OFFSCREEN_PING_ATTEMPTS = 40;
const OFFSCREEN_PING_INTERVAL_MS = 200;
const OFFSCREEN_PING_TIMEOUT_MS = 500;

/**
 * chrome.offscreen.createDocument() resolve assim que o documento é criado,
 * não quando seu script termina de carregar e registra o listener de
 * mensagens — o bundle do offscreen é grande (embarca o motor de
 * transcrição). Mandar o comando real cedo demais podia chegar antes do
 * listener existir e ficar pendurado para sempre, sem nunca chamar o
 * callback (nem sucesso, nem erro).
 *
 * Por isso primeiro se espera o offscreen responder a um PING inofensivo
 * (repetido com timeout curto por tentativa, já que o próprio PING pode
 * sofrer do mesmo problema), e só então o comando real é enviado — uma
 * única vez, sem timeout curto, porque a partir daí é uma operação legítima
 * que pode envolver prompt de permissão do usuário.
 */
/**
 * O handshake só precisa acontecer uma vez por documento: depois que o
 * offscreen respondeu, o listener dele está registrado e continua registrado
 * enquanto o documento viver.
 *
 * Repetir o PING a cada trecho era caro no áudio da aba: a inferência do
 * Whisper ocupa a thread do documento, então um PING mandado no meio dela
 * estourava os 500 ms e caía no laço de retry de 200 ms — segundos de atraso
 * somados a cada bloco, justamente quando a transcrição já estava atrasada.
 * `ensureOffscreenDocument` zera esta marca ao criar um documento novo.
 */
let offscreenReady = false;

async function waitForOffscreenReady(): Promise<void> {
  if (offscreenReady) return;
  for (let attempt = 0; attempt < OFFSCREEN_PING_ATTEMPTS; attempt += 1) {
    try {
      await withTimeout(sendExtensionMessage({ type: 'NEOTALK_OFFSCREEN_PING' }), OFFSCREEN_PING_TIMEOUT_MS, 'offscreen-ping-timeout');
      offscreenReady = true;
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, OFFSCREEN_PING_INTERVAL_MS));
    }
  }
  throw new Error('offscreen-unavailable');
}

async function sendToOffscreen(message: RuntimeMessage): Promise<CaptureResponse> {
  await waitForOffscreenReady();
  return sendExtensionMessage(message);
}

/**
 * Tenta a captura ao vivo, que roda dentro da própria página por
 * `captureStream()` — é a mesma que o botão do balão usa, com prévias a cada
 * ~1,2 s. Antes, quem clicava pelo popup caía direto no `tabCapture` e só via
 * texto no fechamento do trecho (até 5 s): o mesmo botão entregava duas
 * experiências diferentes conforme onde fosse clicado.
 *
 * Devolve `null` quando este caminho não serve para a página — sem elemento de
 * mídia tocando, ou sem content script (páginas internas, ou aba carregada
 * antes da extensão). Aí o `tabCapture` assume, como sempre fez.
 */
async function tryPageAudio(tabId: number): Promise<CaptureResponse | null> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'NEOTALK_START_PAGE_AUDIO' }) as CaptureResponse | undefined;
    if (!response || response.error === NO_MEDIA_ELEMENT) return null;
    return response;
  } catch {
    return null;
  }
}

async function startTabAudio(): Promise<CaptureResponse> {
  try {
    await saveCaptionState({ caption: '', partialCaption: '', status: MESSAGES.listening, error: undefined });
    const tab = await getActiveTab();
    if (!tab?.id || !tab.url || RESTRICTED_URL.test(tab.url) || tab.url.includes('chromewebstore.google.com')) {
      throw new Error(RESTRICTED_PAGE_MESSAGE);
    }

    const live = await tryPageAudio(tab.id);
    if (live) {
      if (!live.ok) throw new Error(live.error);
      return live;
    }

    if (!chrome.tabCapture?.getMediaStreamId) throw new Error(MESSAGES.tabAudioUnsupported);
    await saveAudioCaptureState({ phase: 'starting', mode: 'tab', tabId: tab.id });
    await ensureOffscreenDocument();
    const streamId = await getCurrentTabStreamId(tab.id);
    const result = await sendToOffscreen({ type: 'NEOTALK_OFFSCREEN_START', streamId });
    if (!result.ok) throw new Error(result.error);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const displayed = message === RESTRICTED_PAGE_MESSAGE ? RESTRICTED_PAGE_MESSAGE
      : message === MESSAGES.tabAudioUnsupported ? MESSAGES.tabAudioUnsupported
        : MESSAGES.tabAudioStartFailed;
    await saveAudioCaptureState({ phase: 'error', mode: 'tab', message: displayed });
    await saveCaptionState({ status: '', error: displayed });
    await addDeveloperError(displayed, error);
    console.warn('NeoTalk: falha técnica ao capturar áudio da aba.', error);
    return { ok: false, error: displayed };
  }
}

async function stopTabAudio(): Promise<CaptureResponse> {
  // Os dois caminhos são parados sem saber qual estava em uso: a captura ao vivo
  // vive no content script da aba dona (`state.tabId`), a antiga no documento
  // offscreen. Parar o caminho que não estava rodando não custa nada.
  const state = await getAudioCaptureState();
  const tabId = state.tabId ?? (await getActiveTab())?.id;
  if (tabId !== undefined) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'NEOTALK_STOP_PAGE_AUDIO' });
    } catch {
      // Aba fechada ou sem content script: nada a parar deste lado.
    }
  }
  try {
    await sendExtensionMessage({ type: 'NEOTALK_OFFSCREEN_STOP' });
  } catch {
    // A ausência temporária do documento offscreen não deve quebrar a UI.
  }
  await saveCaptionState({ status: '', error: undefined });
  return { ok: true };
}
async function startMicrophone(): Promise<CaptureResponse> {
  try {
    // Limpa a legenda de uma tradução anterior — senão a caixa de texto (que
    // agora espelha `caption` ao vivo, ver `content-script.ts`) começaria
    // mostrando texto velho até a primeira frase nova chegar.
    await saveCaptionState({ caption: '', partialCaption: '', status: MESSAGES.listening, error: undefined });
    await saveAudioCaptureState({ phase: 'starting', mode: 'microphone' });
    await ensureOffscreenDocument();
    const result = await sendToOffscreen({ type: 'NEOTALK_OFFSCREEN_START_MIC' });
    if (!result.ok) throw new Error(result.error);
    return result;
  } catch (error) {
    const permissionRequired = error instanceof Error && error.message === MICROPHONE_PERMISSION_REQUIRED;
    const timedOut = error instanceof Error && error.message === MICROPHONE_TIMEOUT;
    const displayed = permissionRequired ? MESSAGES.microphonePermissionRequired : timedOut ? MESSAGES.microphoneTimeout : MESSAGES.microphoneStartFailed;
    await saveAudioCaptureState({ phase: 'error', mode: 'microphone', message: displayed });
    await saveCaptionState({ status: '', error: displayed });
    await addDeveloperError(displayed, error);
    console.warn('NeoTalk: falha técnica ao capturar microfone.', error);
    // O documento offscreen é invisível e nunca mostra o prompt de
    // permissão; a página de opções é a única que consegue. Um timeout com a
    // permissão já concedida não tem nada de novo pra autorizar ali — não
    // faz sentido abrir a página de novo.
    if (permissionRequired) void chrome.runtime.openOptionsPage();
    return { ok: false, error: displayed };
  }
}

async function stopMicrophone(): Promise<CaptureResponse> {
  try {
    await sendExtensionMessage({ type: 'NEOTALK_OFFSCREEN_STOP_MIC' });
  } catch {
    // A ausência temporária do documento offscreen não deve quebrar a UI.
  }
  await saveCaptionState({ status: '', error: undefined });
  return { ok: true };
}

async function requestStart(mode: AudioCaptureMode): Promise<CaptureResponse> {
  const now = Date.now();
  const current = await getAudioCaptureState();
  if (shouldIgnoreStart(current, mode, now)) return { ok: true };

  // Só uma fonte por vez: transcrições sobrepostas chegariam embaralhadas.
  if (conflictingMode(current, mode)) await requestStop();

  return mode === 'tab' ? startTabAudio() : startMicrophone();
}

async function requestStop(): Promise<CaptureResponse> {
  const current = await getAudioCaptureState();
  if (shouldIgnoreStop(current, Date.now())) return { ok: true };
  await saveAudioCaptureState({ phase: 'stopping', mode: current.mode, sessionId: current.sessionId });
  return current.mode === 'microphone' ? stopMicrophone() : stopTabAudio();
}

const transcriptionChains = new Map<string, Promise<void>>();
const lastSequences = new Map<string, number>();
/** Última sequência já exibida na legenda, por sessão — independente de quando a tradução daquele trecho roda. */
const lastDisplayedSequence = new Map<string, number>();
/** Quantas frases da sessão ainda esperam a vez de virar vídeo. */
const pendingTranslations = new Map<string, number>();
/** Frases já reconhecidas na sessão, na ordem em que chegaram — a legenda ao vivo mostra tudo junto, como uma transcrição crescendo. */
const accumulatedTranscripts = new Map<string, string[]>();

type TranscribedSegment = { frase: string; sessionId: string; sequence: number; mode: AudioCaptureMode; partial?: boolean };

function translationQueueMessage(pending: number): string {
  return pending > 1 ? `${MESSAGES.processing} (${pending} na fila)` : MESSAGES.processing;
}

/**
 * Texto ainda em reconhecimento: aparece na hora e será substituído.
 *
 * Fica fora de tudo que é definitivo — não entra em `accumulatedTranscripts`,
 * não avança sequência e não vai para tradução. Ele existe só para a tela não
 * ficar parada enquanto a pessoa fala (ou enquanto o vídeo da aba toca), e é
 * apagado assim que o texto confirmado daquele trecho chega.
 */
function showPartial(segment: TranscribedSegment): void {
  const phrase = sanitizePhrase(segment.frase, { maxChars: 5_000 });
  if (!phrase) return;
  console.log(`NeoTalk [${segment.mode} parcial]`, phrase);
  void saveCaptionState({ partialCaption: phrase, error: undefined });
}

/**
 * O texto aparece na legenda assim que chega — sem esperar a vez dele na fila
 * de tradução, que roda em `submitPhrase` e pode levar até um minuto por
 * frase (envio + espera do vídeo em Libras). Sem isso, uma frase já
 * transcrita ficava invisível atrás da anterior, e várias apareciam de
 * uma vez só quando a fila finalmente esvaziava.
 *
 * A ordem dos vídeos continua garantida pela corrente por sessionId — só a
 * exibição do texto foi desacoplada dela.
 */
function queueTranscript(segment: TranscribedSegment): Promise<void> {
  if (segment.partial) {
    showPartial(segment);
    return Promise.resolve();
  }

  // normalizeTranscript já tratou os artefatos da transcrição; aqui sobra
  // o que quebra a API: emoji, invisíveis, pontuação tipográfica.
  const phrase = sanitizePhrase(segment.frase, { maxChars: 5_000 });
  const isNewest = Boolean(phrase) && segment.sequence > (lastDisplayedSequence.get(segment.sessionId) ?? 0);
  let countedAsPending = false;

  if (isNewest) {
    lastDisplayedSequence.set(segment.sessionId, segment.sequence);
    const segments = accumulatedTranscripts.get(segment.sessionId) ?? [];
    segments.push(phrase as string);
    accumulatedTranscripts.set(segment.sessionId, segments);
    const pending = (pendingTranslations.get(segment.sessionId) ?? 0) + 1;
    pendingTranslations.set(segment.sessionId, pending);
    countedAsPending = true;
    const caption = segments.join(' ');
    console.log(`NeoTalk [${segment.mode} FINAL]`, phrase, '| legenda:', caption);
    // `partialCaption: ''` apaga a prévia: o texto confirmado deste trecho já
    // está em `caption`, e deixá-la viva duplicaria o mesmo conteúdo na tela.
    void saveCaptionState({ caption, partialCaption: '', status: translationQueueMessage(pending), error: undefined });
  }

  const previous = transcriptionChains.get(segment.sessionId) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      if (segment.sequence <= (lastSequences.get(segment.sessionId) ?? 0)) return;
      lastSequences.set(segment.sessionId, segment.sequence);
      if (!phrase) return;
      const pending = pendingTranslations.get(segment.sessionId) ?? 1;
      await saveCaptionState({ status: translationQueueMessage(pending) });
      // A legenda já mostra este texto (escrito acima, na chegada) — aqui só
      // a tradução de fato roda; `submitPhrase` não deve reescrevê-la.
      await submitPhrase(phrase, segment.mode === 'microphone' ? 'microphone' : 'tab-audio', true);
    } finally {
      if (countedAsPending) {
        const remaining = Math.max(0, (pendingTranslations.get(segment.sessionId) ?? 1) - 1);
        if (remaining > 0) pendingTranslations.set(segment.sessionId, remaining);
        else pendingTranslations.delete(segment.sessionId);
      }
    }
  }).finally(() => {
    if (transcriptionChains.get(segment.sessionId) === next) transcriptionChains.delete(segment.sessionId);
  });
  transcriptionChains.set(segment.sessionId, next);
  return next;
}

/**
 * Trecho de áudio já cortado na pausa da fala pelo content script (captura
 * de aba via captureStream, sem exigir tabCapture nem ícone da extensão).
 * O offscreen só empresta o modelo já carregado; quem grava é a página.
 */
async function handlePageAudioChunk(message: PageAudioChunkMessage): Promise<CaptureResponse> {
  try {
    await ensureOffscreenDocument();
    const result = await sendToOffscreen({ type: 'NEOTALK_OFFSCREEN_TRANSCRIBE_CHUNK', audioBase64: message.audioBase64, mimeType: message.mimeType });
    if (!result.ok) throw new Error(result.error);
    if (result.text) await queueTranscript({ frase: result.text, sessionId: message.sessionId, sequence: message.sequence, mode: 'tab', partial: message.partial });
    return { ok: true };
  } catch (error) {
    // Uma prévia que falha não vira erro na tela: ela é descartável, e a
    // próxima sai ~1,2 s depois. Só o trecho definitivo merece aviso.
    if (message.partial) return { ok: false, error: 'partial-failed' };
    // Um trecho falho não derruba a sessão inteira — a próxima pausa tenta de
    // novo. Mas silêncio total também não: sem isto, uma falha (rede, corrida
    // de documento offscreen, etc.) só aparecia no log de desenvolvedor —
    // parecia que nada estava acontecendo no balão.
    void saveCaptionState({ status: '', error: MESSAGES.chunkTranscriptionFailed });
    await addDeveloperError('Não foi possível transcrever um trecho do áudio da aba.', error);
    return { ok: false, error: error instanceof Error ? error.message : 'transcribe-failed' };
  }
}

void migrateStoredApiKey();
chrome.runtime.onInstalled.addListener(() => void migrateStoredApiKey());

function resetCaptureState(): void {
  void saveAudioCaptureState({ phase: 'inactive' });
}

chrome.runtime.onStartup.addListener(resetCaptureState);
chrome.runtime.onInstalled.addListener(resetCaptureState);

/** Fechar a aba capturada encerra a captura. */
chrome.tabs.onRemoved.addListener((tabId) => {
  void getAudioCaptureState().then((state) => {
    if (state.mode === 'tab' && state.tabId === tabId) void queueCapture(requestStop);
  });
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  void (async () => {
    // O balão precisa saber em que aba está, para o botão da aba não aparecer
    // como ativo nas outras.
    if (message.type === 'NEOTALK_WHICH_TAB') {
      sendResponse({ tabId: sender.tab?.id ?? null });
      return;
    }

    if (message.type === 'NEOTALK_SUBMIT_PHRASE') {
      const frase = sanitizePhrase(message.frase);
      if (!frase) {
        await saveCaptionState({ caption: message.frase, status: '', error: MESSAGES.nothingToTranslate });
        sendResponse({ ok: false, error: MESSAGES.nothingToTranslate });
        return;
      }
      if (message.source === 'selection') {
        await saveSelectedText(frase);
        await saveCaptionState({ caption: frase, status: 'Texto selecionado pronto para traduzir.', error: undefined });
      }
      const fileUrl = await submitPhrase(frase, message.source);
      sendResponse({ ok: Boolean(fileUrl), fileUrl });
      return;
    }

    if (message.type === 'NEOTALK_TAB_AUDIO_TRANSCRIPT') {
      await queueTranscript(message);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'NEOTALK_PAGE_AUDIO_CHUNK') {
      sendResponse(await handlePageAudioChunk(message));
      return;
    }

    if (message.type === 'NEOTALK_START_TAB_AUDIO') {
      sendResponse(await queueCapture(() => requestStart('tab')));
      return;
    }

    if (message.type === 'NEOTALK_STOP_TAB_AUDIO') {
      sendResponse(await queueCapture(requestStop));
      return;
    }

    if (message.type === 'NEOTALK_START_MICROPHONE') {
      sendResponse(await queueCapture(() => requestStart('microphone')));
      return;
    }

    if (message.type === 'NEOTALK_STOP_MICROPHONE') {
      sendResponse(await queueCapture(requestStop));
    }
  })();

  return true;
});
