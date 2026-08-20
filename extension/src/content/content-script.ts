import { isActiveFor, isTransitional, reconcile } from '../shared/capture-guard.js';
import { captureErrorMessage } from '../shared/messages.js';
import { addDeveloperError, clearCaptionState, DEFAULT_AVATAR3D_URL, getPreferences } from '../shared/storage.js';
import { sanitizePhrase } from '../shared/text.js';
import { SignQueue } from './sign-queue.js';
import { EXTENSION_HOST_ID } from './page-audio-utils.js';
import { isPageAudioActive, startPageAudioCapture, stopPageAudioCapture } from './page-audio.js';
import type { AudioCaptureMode, AudioCaptureState } from '../shared/types.js';

type NeoTalkSelectionMessage = {
  type: 'NEOTALK_SUBMIT_PHRASE';
  frase: string;
  source: 'selection';
};

type SelectionPreferences = { selectionModeEnabled?: boolean; autoSubmitSelection?: boolean; captionsEnabled?: boolean; avatarExpanded?: boolean };
type CaptionState = { caption?: string; partialCaption?: string; status?: string; fileUrl?: string; error?: string };

const HOST_ID = EXTENSION_HOST_ID;
/** Limite por frase do POST /api/v1/mvp/sign do Avatar3D. */
const MAX_PHRASE_CHARS = 500;
/** Origem das páginas desta extensão — alvo exato do postMessage para a ponte. */
const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
const TOOLTIP_CLASS = 'neotalk-extension-tooltip';
const PANEL_CLASS = 'neotalk-extension-panel';
let selectedPhrase = '';
let hideTimer: number | undefined;
let selectionModeEnabled = true;
let autoSubmitSelection = false;
let lastAutoSubmittedPhrase = '';
let isDraggingPanel = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

function sendSelectedPhrase(frase: string): void {
  if (!frase || frase.trim().length === 0) return;
  const message: NeoTalkSelectionMessage = { type: 'NEOTALK_SUBMIT_PHRASE', frase: frase.trim(), source: 'selection' };
  void chrome.runtime.sendMessage(message);
}

function createSelectionUi(): { tooltip: HTMLButtonElement; panel: HTMLElement; textarea: HTMLTextAreaElement; sendButton: HTMLButtonElement; header: HTMLElement; video: HTMLIFrameElement; avatarWindowButton: HTMLButtonElement; status: HTMLElement; menuButton: HTMLButtonElement; actions: HTMLElement; tabAudioButton: HTMLButtonElement; microphoneButton: HTMLButtonElement; minimizeButton: HTMLButtonElement; bubble: HTMLButtonElement } {
  const existingHost = document.getElementById(HOST_ID);
  if (existingHost?.shadowRoot) {
    const existingTooltip = existingHost.shadowRoot.querySelector<HTMLButtonElement>(`.${TOOLTIP_CLASS}`);
    const existingPanel = existingHost.shadowRoot.querySelector<HTMLElement>(`.${PANEL_CLASS}`);
    const existingTextarea = existingHost.shadowRoot.querySelector<HTMLTextAreaElement>('#neotalk-extension-selection-text');
    const existingSendButton = existingHost.shadowRoot.querySelector<HTMLButtonElement>('#neotalk-extension-selection-send');
    const existingHeader = existingHost.shadowRoot.querySelector<HTMLElement>('.neotalk-extension-panel-header');
    const existingVideo = existingHost.shadowRoot.querySelector<HTMLIFrameElement>('#neotalk-extension-avatar-frame');
    const existingAvatarWindowButton = existingHost.shadowRoot.querySelector<HTMLButtonElement>('#neotalk-extension-avatar-window');
    const existingStatus = existingHost.shadowRoot.querySelector<HTMLElement>('#neotalk-extension-status');
    const existingMenuButton = existingHost.shadowRoot.querySelector<HTMLButtonElement>('#neotalk-extension-menu');
    const existingActions = existingHost.shadowRoot.querySelector<HTMLElement>('#neotalk-extension-actions');
    const existingTabAudioButton = existingHost.shadowRoot.querySelector<HTMLButtonElement>('#neotalk-extension-tab-audio');
    const existingMicrophoneButton = existingHost.shadowRoot.querySelector<HTMLButtonElement>('#neotalk-extension-microphone');
    const existingMinimizeButton = existingHost.shadowRoot.querySelector<HTMLButtonElement>('#neotalk-extension-minimize');
    const existingBubble = existingHost.shadowRoot.querySelector<HTMLButtonElement>('.neotalk-extension-bubble');
    if (existingTooltip && existingPanel && existingTextarea && existingSendButton && existingHeader && existingVideo && existingAvatarWindowButton && existingStatus && existingMenuButton && existingActions && existingTabAudioButton && existingMicrophoneButton && existingMinimizeButton && existingBubble) {
      return { tooltip: existingTooltip, panel: existingPanel, textarea: existingTextarea, sendButton: existingSendButton, header: existingHeader, video: existingVideo, avatarWindowButton: existingAvatarWindowButton, status: existingStatus, menuButton: existingMenuButton, actions: existingActions, tabAudioButton: existingTabAudioButton, microphoneButton: existingMicrophoneButton, minimizeButton: existingMinimizeButton, bubble: existingBubble };
    }
  }

  const host = existingHost ?? document.createElement('div');
  host.id = HOST_ID;
  if (!existingHost) document.documentElement.appendChild(host);

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .${TOOLTIP_CLASS} {
        position: fixed;
        z-index: 2147483647;
        max-width: min(240px, calc(100vw - 24px));
        border: 0;
        border-radius: 999px;
        padding: 10px 14px;
        background: linear-gradient(135deg, #1d8eff, #0f6fe0);
        color: #ffffff;
        font: 700 13px Arial, Helvetica, sans-serif;
        cursor: pointer;
        box-shadow: 0 10px 28px rgba(15, 23, 42, .30);
      }
      .${PANEL_CLASS} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483646;
        width: min(340px, calc(100vw - 24px));
        border: 1px solid rgba(29, 142, 255, .22);
        border-radius: 18px;
        background: #ffffff;
        color: #0f172a;
        box-shadow: 0 18px 48px rgba(15, 23, 42, .24);
        overflow: hidden;
        font: 14px Arial, Helvetica, sans-serif;
      }
      .neotalk-extension-panel-brand {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 10px 12px 8px;
        background: #ffffff;
        border-bottom: 1px solid #e2e8f0;
      }
      .neotalk-extension-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 12px;
        background: linear-gradient(135deg, #1d8eff, #0f6fe0);
        color: #ffffff;
        font-weight: 800;
        cursor: move;
        user-select: none;
      }
      .neotalk-extension-panel-title { display: inline-flex; align-items: center; gap: 8px; }
      #neotalk-extension-menu { border: 0; border-radius: 999px; width: 30px; height: 30px; background: rgba(255,255,255,.18); color: #fff; cursor: pointer; font-size: 18px; line-height: 1; }
      #neotalk-extension-minimize {
        border: 0;
        border-radius: 999px;
        width: 30px;
        height: 30px;
        background: rgba(255,255,255,.18);
        color: #fff;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
      }
      .neotalk-extension-bubble {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483646;
        width: 52px;
        height: 52px;
        border-radius: 50%;
        border: 0;
        background: linear-gradient(135deg, #1d8eff, #0f6fe0);
        color: #ffffff;
        font: 800 20px Arial, Helvetica, sans-serif;
        cursor: pointer;
        box-shadow: 0 10px 28px rgba(15, 23, 42, .30);
      }
      .neotalk-extension-panel-body { display: grid; gap: 8px; padding: 12px; }
      .neotalk-extension-avatar-box { min-height: 220px; border-radius: 14px; overflow: hidden; background: #ffffff; display: flex; align-items: center; justify-content: center; position: relative; }
      .neotalk-extension-avatar-box:not(.expanded) { min-height: 150px; max-height: 180px; }
      #neotalk-extension-avatar-frame { width: 100%; height: 100%; min-height: inherit; border: 0; display: block; background: #ffffff; }
      [hidden] { display: none !important; }
      .neotalk-extension-avatar-box { flex-direction: column; gap: 10px; }
      #neotalk-extension-avatar-placeholder { margin: 0; padding: 14px; color: #475569; text-align: center; font-size: 13px; }
      #neotalk-extension-avatar-window {
        border: 0; border-radius: 12px; padding: 10px 14px;
        background: #1d8eff; color: #ffffff;
        font: 700 13px Arial, Helvetica, sans-serif; cursor: pointer;
      }
      #neotalk-extension-status { min-height: 18px; color: #475569; font-size: 12px; }
      #neotalk-extension-actions[hidden] { display: none; }
      #neotalk-extension-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .neotalk-extension-capture {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        min-height: 44px; padding: 0 10px; border: 0; border-radius: 12px;
        color: #ffffff; font: 700 13px Arial, Helvetica, sans-serif; cursor: pointer;
        transition: background-color .15s ease;
      }
      .neotalk-extension-capture .neotalk-extension-icon { font-size: 11px; line-height: 1; }
      /* Ocioso: azul da marca. Ativo (clique para parar): preto. */
      .neotalk-extension-capture.is-idle { background: #1d8eff; }
      .neotalk-extension-capture.is-transition { background: #475569; cursor: progress; }
      .neotalk-extension-capture.is-active { background: #000000; }
      .neotalk-extension-capture[disabled] { opacity: .9; }
      #neotalk-extension-selection-text {
        width: 100%;
        min-height: 76px;
        resize: vertical;
        padding: 10px;
        border: 1px solid #94a3b8;
        border-radius: 12px;
        color: #0f172a;
        font: 14px Arial, Helvetica, sans-serif;
        box-sizing: border-box;
      }
      #neotalk-extension-selection-send {
        border: 0;
        border-radius: 12px;
        padding: 10px 12px;
        background: #1d8eff;
        color: #ffffff;
        font-weight: 800;
        cursor: pointer;
      }
      .neotalk-extension-helper { margin: 0; color: #475569; font-size: 12px; line-height: 1.35; }
      .${TOOLTIP_CLASS}:focus-visible, #neotalk-extension-selection-text:focus-visible, #neotalk-extension-selection-send:focus-visible, #neotalk-extension-menu:focus-visible, #neotalk-extension-tab-audio:focus-visible, #neotalk-extension-minimize:focus-visible, .neotalk-extension-bubble:focus-visible {
        outline: 3px solid #facc15;
        outline-offset: 2px;
      }
    </style>
    <button class="${TOOLTIP_CLASS}" type="button" aria-label="Traduzir texto selecionado para Libras">Traduzir para Libras</button>
    <aside class="${PANEL_CLASS}" aria-label="NeoTalk modo seleção">
      <div class="neotalk-extension-panel-brand"><svg width="28" height="22" viewBox="0 0 40 30" aria-hidden="true" focusable="false"><rect x="2" y="2" width="16" height="20" rx="6" fill="#1d8eff"/><path d="M6 20 L6 26 L11.5 20 Z" fill="#1d8eff"/><circle cx="10" cy="11" r="2.6" fill="#ffffff"/><rect x="22" y="2" width="16" height="20" rx="6" fill="#1d8eff"/><path d="M34 20 L34 26 L28.5 20 Z" fill="#1d8eff"/><circle cx="30" cy="11" r="2.6" fill="#ffffff"/></svg><strong style="font: 800 16px Arial, Helvetica, sans-serif; color: #0f172a; letter-spacing: -.02em;">NeoTalk</strong></div>
      <div class="neotalk-extension-panel-header"><span class="neotalk-extension-panel-title">NeoTalk seleção <small>arraste</small></span><button id="neotalk-extension-minimize" type="button" aria-label="Minimizar painel">−</button><button id="neotalk-extension-menu" type="button" aria-label="Abrir ações">⋯</button></div>
      <div class="neotalk-extension-panel-body">
        <div class="neotalk-extension-avatar-box">
          <iframe id="neotalk-extension-avatar-frame" title="Avatar 3D NeoTalk" allow="autoplay" hidden></iframe>
          <p id="neotalk-extension-avatar-placeholder">Avatar aguardando tradução.</p>
          <button id="neotalk-extension-avatar-window" type="button" hidden>Abrir avatar em outra janela</button>
        </div>
        <div id="neotalk-extension-status" aria-live="polite"></div>
        <textarea id="neotalk-extension-selection-text" aria-label="Texto para traduzir, e transcrição ao vivo durante a captura" aria-live="polite" placeholder="Selecione um texto na página, digite aqui, ou ative o microfone."></textarea>
        <button id="neotalk-extension-selection-send" type="button">Traduzir para Libras</button>
        <div id="neotalk-extension-actions">
          <button id="neotalk-extension-microphone" class="neotalk-extension-capture is-idle" type="button" data-mode="microphone" aria-pressed="false">
            <span class="neotalk-extension-icon" aria-hidden="true">&#9679;</span><span class="neotalk-extension-label">Microfone</span>
          </button>
          <button id="neotalk-extension-tab-audio" class="neotalk-extension-capture is-idle" type="button" data-mode="tab" aria-pressed="false">
            <span class="neotalk-extension-icon" aria-hidden="true">&#9679;</span><span class="neotalk-extension-label">Áudio da aba</span>
          </button>
        </div>
        <p class="neotalk-extension-helper">Ao selecionar texto com o mouse, ele aparece aqui e é enviado automaticamente quando o modo seleção está ativo.</p>
      </div>
    </aside>
    <button class="neotalk-extension-bubble" type="button" aria-label="Abrir NeoTalk" hidden>N</button>
  `;

  return {
    tooltip: shadow.querySelector<HTMLButtonElement>(`.${TOOLTIP_CLASS}`)!,
    panel: shadow.querySelector<HTMLElement>(`.${PANEL_CLASS}`)!,
    textarea: shadow.querySelector<HTMLTextAreaElement>('#neotalk-extension-selection-text')!,
    sendButton: shadow.querySelector<HTMLButtonElement>('#neotalk-extension-selection-send')!,
    header: shadow.querySelector<HTMLElement>('.neotalk-extension-panel-header')!,
    video: shadow.querySelector<HTMLIFrameElement>('#neotalk-extension-avatar-frame')!,
    avatarWindowButton: shadow.querySelector<HTMLButtonElement>('#neotalk-extension-avatar-window')!,
    status: shadow.querySelector<HTMLElement>('#neotalk-extension-status')!,
    menuButton: shadow.querySelector<HTMLButtonElement>('#neotalk-extension-menu')!,
    actions: shadow.querySelector<HTMLElement>('#neotalk-extension-actions')!,
    tabAudioButton: shadow.querySelector<HTMLButtonElement>('#neotalk-extension-tab-audio')!,
    microphoneButton: shadow.querySelector<HTMLButtonElement>('#neotalk-extension-microphone')!,
    minimizeButton: shadow.querySelector<HTMLButtonElement>('#neotalk-extension-minimize')!,
    bubble: shadow.querySelector<HTMLButtonElement>('.neotalk-extension-bubble')!
  };
}

const selectionUi = createSelectionUi();
selectionUi.tooltip.style.display = 'none';

let isMinimized = false;
/**
 * O balão começa fechado em toda página e não é persistido: abrir é sempre um
 * ato explícito, pelo popup da extensão ou pelo tooltip de seleção. Antes ele
 * era criado e exibido em `<all_urls>`, aparecendo sozinho em tudo que abria.
 */
let panelOpen = false;

function updatePanelVisibility(): void {
  if (isMinimized) return;
  selectionUi.panel.style.display = panelOpen ? 'block' : 'none';
}

function updateMinimizedState(): void {
  if (!panelOpen) {
    selectionUi.panel.style.display = 'none';
    selectionUi.bubble.hidden = true;
    return;
  }
  if (isMinimized) {
    selectionUi.panel.style.display = 'none';
    selectionUi.bubble.hidden = false;
  } else {
    selectionUi.bubble.hidden = true;
    updatePanelVisibility();
  }
}

function updateOverlayState(state: CaptionState): void {
  lastCaptionState = state;
  console.log('NeoTalk [balão]', { confirmado: state.caption, parcial: state.partialCaption ?? '', status: state.error || state.status || '' });
  selectionUi.status.textContent = state.error || state.status || '';
  applyTextareaLock();
  // O avatar não depende mais do estado de legenda: quem o alimenta é a fila de
  // sinais, e ele vive dentro do iframe da ponte enquanto o balão estiver aberto.
}

function applyPreferences(preferences?: SelectionPreferences): void {
  selectionModeEnabled = preferences?.selectionModeEnabled ?? true;
  autoSubmitSelection = preferences?.autoSubmitSelection ?? false;
  selectionUi.video.parentElement?.classList.toggle('expanded', preferences?.avatarExpanded ?? true);
  // `selectionModeEnabled` governa só o tooltip de seleção; quem abre e fecha o
  // balão é `panelOpen`.
  updateMinimizedState();
}

let captureState: AudioCaptureState = { phase: 'inactive', updatedAt: 0 };
let captureWatchdog: number | undefined;
let currentTabId: number | null = null;
let lastCaptionState: CaptionState = {};

/**
 * Enquanto microfone ou áudio da aba estiverem capturando nesta aba, a
 * transcrição ao vivo (campo `caption`, que acumula frase por frase) aparece
 * direto na caixa de seleção, travada para não perder texto se o usuário
 * mexer nela sem querer. Some a captura, a caixa libera de novo.
 *
 * Chamada tanto quando a legenda muda quanto quando o estado de captura
 * muda — são dois eventos de storage independentes, e a caixa precisa
 * destravar assim que a captura para, mesmo sem uma legenda nova chegando
 * junto.
 */
function applyTextareaLock(): void {
  const capturing = isActiveFor(captureState, 'microphone', currentTabId) || isActiveFor(captureState, 'tab', currentTabId);
  selectionUi.textarea.readOnly = capturing;
  // A prévia entra junto: é o que mantém a caixa acompanhando a fala em tempo
  // real. Ela some sozinha quando o texto confirmado daquele trecho chega.
  if (capturing) selectionUi.textarea.value = [lastCaptionState.caption, lastCaptionState.partialCaption].filter(Boolean).join(' ');
}

function updateAudioCaptureState(state?: AudioCaptureState): void {
  captureState = state ?? { phase: 'inactive', updatedAt: Date.now() };
  renderCaptureButtons();
  applyTextareaLock();
}

function loadOverlayState(): void {
  chrome.storage.local.get('neotalkCaptionState', (result) => {
    updateOverlayState((result.neotalkCaptionState as CaptionState | undefined) ?? {});
  });
}

function loadSelectionModePreference(): void {
  chrome.storage.sync.get('neotalkPreferences', (result) => {
    const preferences = result.neotalkPreferences as SelectionPreferences | undefined;
    applyPreferences(preferences);
  });
  chrome.storage.local.get('neotalkAudioCaptureState', (result) => updateAudioCaptureState(result.neotalkAudioCaptureState as AudioCaptureState | undefined));
}

void chrome.runtime.sendMessage({ type: 'NEOTALK_WHICH_TAB' }).then(
  (response: { tabId?: number } | undefined) => {
    currentTabId = response?.tabId ?? null;
    renderCaptureButtons();
  },
  () => undefined
);

updateMinimizedState();
loadSelectionModePreference();
loadOverlayState();
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.neotalkPreferences) {
    const preferences = changes.neotalkPreferences.newValue as SelectionPreferences | undefined;
    applyPreferences(preferences);
  }
  if (areaName === 'local' && changes.neotalkCaptionState) {
    updateOverlayState((changes.neotalkCaptionState.newValue as CaptionState | undefined) ?? {});
  }
  if (areaName === 'local' && changes.neotalkAudioCaptureState) updateAudioCaptureState(changes.neotalkAudioCaptureState.newValue as AudioCaptureState | undefined);
});

/**
 * Abrir o balão sempre parte do zero: sem legenda antiga, sem vídeo tocando e
 * sem texto no campo. O estado de legenda vive em `chrome.storage.local` e era
 * restaurado em toda página, trazendo de volta a última tradução (e disparando
 * o vídeo em loop) sem ninguém pedir.
 */
function openPanel(): void {
  panelOpen = true;
  isMinimized = false;
  selectionUi.textarea.value = '';
  selectedPhrase = '';
  lastAutoSubmittedPhrase = '';
  updateOverlayState({});
  void clearCaptionState();
  mountAvatar();
  updateMinimizedState();
}

function closePanel(): void {
  panelOpen = false;
  unmountAvatar();
  updateMinimizedState();
}

/* ------------------------------------------------------------------ avatar 3D */

/**
 * O avatar 3D vive num iframe da PRÓPRIA extensão (`src/avatar/avatar.html`), que
 * por sua vez embute o widget do Avatar3D. O desvio é obrigatório: um iframe para
 * domínio externo criado por content script obedece ao `frame-src` da página
 * hospedeira, e o balão roda em `<all_urls>` — em sites com CSP restrito o avatar
 * não carregaria. Recursos de `web_accessible_resources` são isentos desse CSP.
 *
 * O token é o segredo desta sessão entre o balão e a ponte: o `window.parent` da
 * ponte é a página do usuário, então sem ele qualquer script daquela página
 * poderia mandar o avatar sinalizar texto arbitrário.
 */
let avatarToken = '';

const signQueue = new SignQueue({
  send: (phrase) => {
    postToAvatar({ type: 'neotalk:sign', phrase });
    selectionUi.status.textContent = 'Traduzindo para Libras...';
  },
  schedule: (run, delayMs) => {
    const timer = window.setTimeout(run, delayMs);
    return () => window.clearTimeout(timer);
  },
  resolveDuration: async (taskId) => {
    if (!taskId) return null;
    try {
      const base = await avatarBaseUrl();
      const response = await fetch(`${base}/api/v1/mvp/tasks/${encodeURIComponent(taskId)}`);
      if (!response.ok) return null;
      const body = await response.json() as { payload?: { pose?: { frame_count?: number; fps?: number } } };
      const pose = body?.payload?.pose;
      if (!pose?.frame_count || !pose.fps) return null;
      return (pose.frame_count / pose.fps) * 1_000;
    } catch {
      // Sem a duração real a fila usa o palpite dela. Uma falha de rede aqui não
      // pode travar as frases seguintes.
      return null;
    }
  }
});

async function avatarBaseUrl(): Promise<string> {
  const preferences = await getPreferences();
  return (preferences.avatar3dUrl || DEFAULT_AVATAR3D_URL).replace(/\/+$/, '');
}

function postToAvatar(command: Record<string, unknown>): void {
  const target = selectionUi.video.contentWindow;
  if (!target || !avatarToken) return;
  target.postMessage({ ...command, neotalkToken: avatarToken }, EXTENSION_ORIGIN);
}

/**
 * Dois prazos, porque são duas falhas diferentes — e confundi-las custa caro.
 *
 * Quando o embutimento é RECUSADO (foi o caso enquanto o `/widget` respondia
 * `frame-ancestors *`, que não cobre `chrome-extension://`), o Chrome desenha uma
 * página de erro DENTRO do iframe e dispara `load` normalmente; de fora, sendo
 * outra origem, não há como ler o que aconteceu. O sintoma é não chegar mensagem
 * NENHUMA da ponte — o frame nem executa.
 *
 * Já o Unity apenas LENTO se anuncia: o widget emite `neotalk:status` com
 * `loading_avatar` antes de começar a baixar o modelo. Ou seja, a primeira
 * mensagem qualquer já prova que o embutimento foi aceito, e a partir dela só
 * resta esperar.
 *
 * Por isso o prazo curto mede "recusado" e é cancelado por qualquer mensagem, e
 * o prazo longo cobre o "aceitou mas travou no meio da carga". Um prazo único
 * esperando por `neotalk:ready` puniria a primeira carga do Unity, que baixa
 * dezenas de megabytes e passa de 30 s numa conexão comum.
 */
const EMBED_REFUSED_TIMEOUT_MS = 10_000;
const EMBED_STALLED_TIMEOUT_MS = 90_000;

let embedTimer: number | undefined;
let embedStallTimer: number | undefined;
/** O embutido foi recusado; as frases passam a ir para a janela separada. */
let embedFailed = false;
/** Guardado na montagem para o clique no botão ser síncrono — `window.open` fora de um gesto do usuário é bloqueado. */
let avatarConfig: { base: string; avatar: string } = { base: DEFAULT_AVATAR3D_URL, avatar: 'lia' };
let avatarWindow: Window | null = null;

function placeholderElement(): HTMLElement | null {
  return selectionUi.video.parentElement?.querySelector<HTMLElement>('#neotalk-extension-avatar-placeholder') ?? null;
}

function mountAvatar(): void {
  avatarToken = crypto.randomUUID();
  embedFailed = false;
  selectionUi.avatarWindowButton.hidden = true;
  void (async () => {
    const preferences = await getPreferences();
    const base = (preferences.avatar3dUrl || DEFAULT_AVATAR3D_URL).replace(/\/+$/, '');
    avatarConfig = { base, avatar: preferences.avatarName ?? 'lia' };
    const hash = new URLSearchParams({
      token: avatarToken,
      base,
      avatar: avatarConfig.avatar,
      // A ponte responde exatamente para esta origem, em vez de '*': a
      // transcrição do microfone passa por essas mensagens.
      parentOrigin: window.location.origin
    });
    selectionUi.video.src = `${chrome.runtime.getURL('src/avatar/avatar.html')}#${hash.toString()}`;
    selectionUi.video.hidden = false;
    const placeholder = placeholderElement();
    if (placeholder) placeholder.hidden = true;

    window.clearTimeout(embedTimer);
    window.clearTimeout(embedStallTimer);
    embedTimer = window.setTimeout(reportEmbedFailure, EMBED_REFUSED_TIMEOUT_MS);
    embedStallTimer = window.setTimeout(reportEmbedFailure, EMBED_STALLED_TIMEOUT_MS);
  })();
}

/**
 * O avatar embutido não subiu. Em vez de deixar as frases se acumularem em
 * silêncio numa fila que nunca vai drenar, o balão diz o que houve e oferece a
 * janela separada — que é página de topo e não sofre `frame-ancestors`.
 */
function reportEmbedFailure(): void {
  if (embedFailed) return;
  embedFailed = true;
  window.clearTimeout(embedTimer);
  window.clearTimeout(embedStallTimer);
  signQueue.reset();
  selectionUi.video.hidden = true;
  selectionUi.video.removeAttribute('src');
  const placeholder = placeholderElement();
  if (placeholder) {
    placeholder.hidden = false;
    placeholder.textContent = 'Esta página não pôde exibir o avatar aqui dentro.';
  }
  selectionUi.avatarWindowButton.hidden = false;
}

function avatarWindowUrl(phrase: string): string {
  const url = new URL('/widget', avatarConfig.base);
  url.searchParams.set('avatar', avatarConfig.avatar);
  url.searchParams.set('controls', '1');
  if (phrase) url.searchParams.set('phrase', phrase);
  return url.toString();
}

/**
 * Manda a frase para a janela separada. Ela não aceita `postMessage` — o widget
 * exige `event.source === window.parent`, e numa janela de topo o pai é ela
 * mesma —, então cada frase entra recarregando a janela com `?phrase=`, que o
 * widget já traduz sozinho ao abrir.
 */
function sendToAvatarWindow(phrase: string): void {
  if (avatarWindow && !avatarWindow.closed) {
    avatarWindow.location.href = avatarWindowUrl(phrase);
    return;
  }
  selectionUi.status.textContent = 'Clique em "Abrir avatar em outra janela" para ver a tradução.';
}

selectionUi.avatarWindowButton.addEventListener('click', () => {
  // Aberta dentro do gesto do usuário, senão o bloqueador de pop-up barra.
  const phrase = sanitizePhrase(selectionUi.textarea.value, { maxChars: MAX_PHRASE_CHARS }) ?? '';
  avatarWindow = window.open(avatarWindowUrl(phrase), 'neotalk-avatar', 'width=460,height=620');
  if (!avatarWindow) {
    selectionUi.status.textContent = 'O navegador bloqueou a janela. Autorize pop-ups para esta página.';
    return;
  }
  selectionUi.status.textContent = '';
});

function unmountAvatar(): void {
  // Descarregar de verdade: o Unity WebGL é pesado, e o balão fechado não pode
  // continuar consumindo memória da aba.
  window.clearTimeout(embedTimer);
  window.clearTimeout(embedStallTimer);
  signQueue.reset();
  avatarToken = '';
  embedFailed = false;
  selectionUi.video.removeAttribute('src');
  selectionUi.video.hidden = true;
  selectionUi.avatarWindowButton.hidden = true;
  const placeholder = placeholderElement();
  if (placeholder) {
    placeholder.hidden = false;
    placeholder.textContent = 'Avatar aguardando tradução.';
  }
}

/** Enfileira uma frase para o avatar, respeitando o limite do servidor. */
function signPhrase(raw: string): void {
  const phrase = sanitizePhrase(raw, { maxChars: MAX_PHRASE_CHARS });
  if (!phrase) return;
  if (raw.trim().length > MAX_PHRASE_CHARS) {
    selectionUi.status.textContent = `Texto cortado em ${MAX_PHRASE_CHARS} caracteres, o limite do avatar.`;
  }
  if (!panelOpen) openPanel();
  if (embedFailed) {
    sendToAvatarWindow(phrase);
    return;
  }
  signQueue.enqueue(phrase);
}

window.addEventListener('message', (event) => {
  if (event.source !== selectionUi.video.contentWindow) return;
  const data = event.data as { type?: string; neotalkToken?: string; taskId?: string; words?: unknown[]; message?: string } | null;
  if (!data || typeof data !== 'object' || !avatarToken || data.neotalkToken !== avatarToken) return;

  console.log('NeoTalk [avatar]', data.type, data);

  // Chegou mensagem: o frame executou, logo o embutimento foi ACEITO. Vale para
  // qualquer tipo — o widget manda `loading_avatar` antes de baixar o Unity, e é
  // isso que separa "lento" de "recusado". Só o prazo longo, contra travamento
  // no meio da carga, continua correndo até o `ready`.
  window.clearTimeout(embedTimer);

  if (data.type === 'neotalk:ready') {
    window.clearTimeout(embedStallTimer);
    signQueue.onReady();
    return;
  }
  if (data.type === 'neotalk:playing') {
    signQueue.onPlaying(data.taskId, Array.isArray(data.words) ? data.words.length : 1);
    selectionUi.status.textContent = '';
    return;
  }
  if (data.type === 'neotalk:error') {
    selectionUi.status.textContent = data.message || 'O avatar não conseguiu sinalizar esta frase.';
    signQueue.onError();
  }
});

/**
 * Liga o áudio da aba por `captureStream()`, aqui dentro da própria página.
 *
 * Usada por dois caminhos: o botão do balão e, via `NEOTALK_START_PAGE_AUDIO`,
 * o botão do popup — que antes caía no `tabCapture` do service worker e só
 * entregava texto no fechamento do trecho (até 5 s), enquanto o balão já
 * mostrava prévias a cada 1,2 s. O mesmo botão se comportava de dois jeitos
 * conforme onde era clicado.
 */
async function startPageAudio(): Promise<{ ok: boolean; error?: string }> {
  // O microfone roda no documento offscreen, sem o balão saber disso sozinho —
  // se estiver ativo, para primeiro. Sem isto, os dois ficavam rodando ao mesmo
  // tempo, disputando o mesmo documento.
  if (isActiveFor(reconcile(captureState, Date.now()), 'microphone', currentTabId)) {
    await chrome.runtime.sendMessage({ type: 'NEOTALK_STOP_MICROPHONE' });
  }
  return startPageAudioCapture(currentTabId);
}

chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
  if (message?.type === 'NEOTALK_TOGGLE_PANEL') {
    if (panelOpen) closePanel();
    else openPanel();
    sendResponse({ open: panelOpen });
    return false;
  }
  if (message?.type === 'NEOTALK_GET_PANEL_STATE') {
    sendResponse({ open: panelOpen });
    return false;
  }
  // O service worker pergunta antes de usar o `tabCapture`: se esta página tem
  // um elemento de mídia tocando, a captura ao vivo acontece aqui.
  if (message?.type === 'NEOTALK_START_PAGE_AUDIO') {
    void startPageAudio().then(sendResponse, (error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : 'page-audio-start-failed' });
    });
    return true;
  }
  if (message?.type === 'NEOTALK_STOP_PAGE_AUDIO') {
    void stopPageAudioCapture().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: true }));
    return true;
  }
  // Frase pronta para virar sinal — vem da transcrição ao vivo (service worker),
  // do popup, ou da seleção de texto. O avatar mora aqui, no balão.
  if (message?.type === 'NEOTALK_SIGN_PHRASE') {
    signPhrase(String((message as { frase?: unknown }).frase ?? ''));
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

function hideTooltip(): void {
  selectionUi.tooltip.style.display = 'none';
}

function getSelectedText(): string {
  return window.getSelection()?.toString().trim() ?? '';
}

function receiveSelectedPhrase(frase: string): void {
  selectedPhrase = frase;
  selectionUi.textarea.value = frase;
  if (selectionModeEnabled && autoSubmitSelection && lastAutoSubmittedPhrase !== frase) {
    lastAutoSubmittedPhrase = frase;
    sendSelectedPhrase(frase);
  }
}

function selectionIsSensitive(selection: Selection): boolean {
  const node = selection.anchorNode;
  const element = (node instanceof Element ? node : node?.parentElement)?.closest('input, textarea, [contenteditable="true"], [contenteditable=""]');
  return Boolean(element);
}

function positionTooltipFromSelection(): void {
  window.clearTimeout(hideTimer);
  const selection = window.getSelection();
  const frase = getSelectedText();

  if (!frase || frase.trim().length === 0 || !selection || selection.rangeCount === 0 || selectionIsSensitive(selection)) {
    hideTooltip();
    return;
  }

  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    hideTooltip();
    return;
  }

  receiveSelectedPhrase(frase);
  selectionUi.tooltip.style.left = `${Math.min(window.innerWidth - 252, Math.max(8, rect.left))}px`;
  selectionUi.tooltip.style.top = `${Math.min(window.innerHeight - 48, Math.max(8, rect.bottom + 8))}px`;
  selectionUi.tooltip.style.display = 'block';
}

document.addEventListener('selectionchange', () => {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(positionTooltipFromSelection, 80);
});
document.addEventListener('mouseup', () => window.setTimeout(positionTooltipFromSelection, 0), true);
document.addEventListener('keyup', (event) => {
  if (event.key === 'Shift' || event.key.startsWith('Arrow')) window.setTimeout(positionTooltipFromSelection, 0);
}, true);

selectionUi.tooltip.addEventListener('mousedown', (event) => event.preventDefault());
selectionUi.tooltip.addEventListener('click', () => {
  const frase = selectedPhrase || getSelectedText();
  // Abrir antes de enviar: `openPanel` limpa o estado, e a tradução que chega em
  // seguida precisa sobreviver a essa limpeza.
  if (!panelOpen) openPanel();
  selectionUi.textarea.value = frase;
  sendSelectedPhrase(frase);
  hideTooltip();
});
selectionUi.sendButton.addEventListener('click', () => sendSelectedPhrase(selectionUi.textarea.value));
selectionUi.menuButton.addEventListener('mousedown', (event) => event.stopPropagation());
selectionUi.menuButton.addEventListener('click', () => { selectionUi.actions.hidden = !selectionUi.actions.hidden; });

selectionUi.minimizeButton.addEventListener('mousedown', (event) => event.stopPropagation());
selectionUi.minimizeButton.addEventListener('click', () => {
  isMinimized = true;
  updateMinimizedState();
});

selectionUi.bubble.addEventListener('click', () => {
  isMinimized = false;
  updateMinimizedState();
});

const NAMES: Record<AudioCaptureMode, string> = { microphone: 'Microfone', tab: 'Áudio da aba' };
const STOP_MESSAGES = { microphone: 'NEOTALK_STOP_MICROPHONE', tab: 'NEOTALK_STOP_TAB_AUDIO' } as const;
const START_MESSAGES = { microphone: 'NEOTALK_START_MICROPHONE', tab: 'NEOTALK_START_TAB_AUDIO' } as const;

function captureButtons(): HTMLButtonElement[] {
  return [selectionUi.microphoneButton, selectionUi.tabAudioButton];
}

function renderCaptureButtons(): void {
  const state = reconcile(captureState, Date.now());

  for (const button of captureButtons()) {
    const mode = button.dataset.mode as AudioCaptureMode;
    const active = isActiveFor(state, mode, currentTabId);
    const transition = active && isTransitional(state.phase);
    const status = transition ? 'transition' : active ? 'active' : 'idle';

    button.className = `neotalk-extension-capture is-${status}`;
    // O botão NUNCA é desabilitado. Desabilitar durante a transição era uma
    // armadilha: `transition` só é verdadeiro para o botão que está ativo, ou
    // seja, exatamente quando o usuário precisa poder parar. Bastava uma
    // gravação de estado se perder para a fase ficar presa em `starting` e não
    // sobrar saída nenhuma a não ser fechar a aba. O duplo start já é impedido
    // no service worker por `shouldIgnoreStart`, e o duplo stop por
    // `shouldIgnoreStop` — desabilitar aqui não protegia nada que já não
    // estivesse protegido.
    button.setAttribute('aria-pressed', String(active));
    button.querySelector('.neotalk-extension-icon')!.textContent = transition ? '◌' : active ? '■' : '●';
    button.querySelector('.neotalk-extension-label')!.textContent = transition
      ? (state.phase === 'stopping' ? 'Parando...' : 'Cancelar')
      : active ? `Parar ${NAMES[mode].toLowerCase()}` : NAMES[mode];
  }

  // Uma transição sem confirmação precisa ser reavaliada, senão o botão
  // ficaria âmbar para sempre caso o service worker fosse encerrado.
  window.clearTimeout(captureWatchdog);
  if (isTransitional(state.phase)) captureWatchdog = window.setTimeout(renderCaptureButtons, 1_000);
}

function displayCaptureError(error: string | undefined, mode: AudioCaptureMode): void {
  // Sem erro a linha precisa ser LIMPA, não ignorada: antes, o erro de um clique
  // ficava na tela e reaparecia no clique seguinte em outro botão — foi o que fez
  // parecer que o microfone também estava quebrado.
  const text = captureErrorMessage(error, mode === 'tab' ? 'tab' : 'microphone');
  selectionUi.status.textContent = text;
  if (error && text !== error) void addDeveloperError(text, error);
}

for (const button of captureButtons()) {
  button.addEventListener('click', () => {
    if (button.disabled) return;
    const mode = button.dataset.mode as AudioCaptureMode;
    const active = isActiveFor(reconcile(captureState, Date.now()), mode, currentTabId);

    if (mode === 'tab') {
      void (async () => {
        if (active) {
          await stopPageAudioCapture();
          return;
        }
        const response = await startPageAudio();
        displayCaptureError(response.error, 'tab');
      })();
      return;
    }

    void (async () => {
      // O áudio da aba pelo balão roda inteiramente aqui na página — o
      // service worker não tem como pará-lo sozinho (só conhece o caminho
      // antigo, via tabCapture, usado pelo popup). Sem isto, ligar o
      // microfone enquanto o áudio da aba do balão está ativo deixava os
      // dois rodando ao mesmo tempo, disputando o mesmo documento offscreen
      // — a causa real do erro de contexto que aparecia no console.
      if (!active && mode === 'microphone' && isPageAudioActive()) await stopPageAudioCapture();
      const type = active ? STOP_MESSAGES[mode] : START_MESSAGES[mode];
      const response = await chrome.runtime.sendMessage({ type });
      displayCaptureError(response?.ok ? undefined : (response?.error ?? ''), mode);
    })();
  });
}

selectionUi.header.addEventListener('mousedown', (event) => {
  isDraggingPanel = true;
  const rect = selectionUi.panel.getBoundingClientRect();
  dragOffsetX = event.clientX - rect.left;
  dragOffsetY = event.clientY - rect.top;
  event.preventDefault();
});
document.addEventListener('mousemove', (event) => {
  if (!isDraggingPanel) return;
  selectionUi.panel.style.left = `${Math.max(8, Math.min(window.innerWidth - selectionUi.panel.offsetWidth - 8, event.clientX - dragOffsetX))}px`;
  selectionUi.panel.style.top = `${Math.max(8, Math.min(window.innerHeight - selectionUi.panel.offsetHeight - 8, event.clientY - dragOffsetY))}px`;
  selectionUi.panel.style.right = 'auto';
  selectionUi.panel.style.bottom = 'auto';
});
document.addEventListener('mouseup', () => { isDraggingPanel = false; }, true);

window.addEventListener('scroll', hideTooltip, { passive: true });
window.addEventListener('resize', hideTooltip, { passive: true });
