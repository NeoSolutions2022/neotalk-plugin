type NeoTalkSelectionMessage = {
  type: 'NEOTALK_SUBMIT_PHRASE';
  frase: string;
  source: 'selection';
};

type SelectionPreferences = { selectionModeEnabled?: boolean };
type CaptionState = { caption?: string; status?: string; fileUrl?: string; error?: string };

const HOST_ID = 'neotalk-extension-selection-host';
const TOOLTIP_CLASS = 'neotalk-extension-tooltip';
const PANEL_CLASS = 'neotalk-extension-panel';
let selectedPhrase = '';
let hideTimer: number | undefined;
let selectionModeEnabled = true;
let lastAutoSubmittedPhrase = '';
let isDraggingPanel = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

function sendSelectedPhrase(frase: string): void {
  if (!frase || frase.trim().length === 0) return;
  const message: NeoTalkSelectionMessage = { type: 'NEOTALK_SUBMIT_PHRASE', frase: frase.trim(), source: 'selection' };
  void chrome.runtime.sendMessage(message);
}

function createSelectionUi(): { tooltip: HTMLButtonElement; panel: HTMLElement; textarea: HTMLTextAreaElement; sendButton: HTMLButtonElement; header: HTMLElement; video: HTMLVideoElement; caption: HTMLElement; status: HTMLElement; menuButton: HTMLButtonElement; actions: HTMLElement; tabAudioButton: HTMLButtonElement } {
  const existingHost = document.getElementById(HOST_ID);
  if (existingHost?.shadowRoot) {
    const existingTooltip = existingHost.shadowRoot.querySelector<HTMLButtonElement>(`.${TOOLTIP_CLASS}`);
    const existingPanel = existingHost.shadowRoot.querySelector<HTMLElement>(`.${PANEL_CLASS}`);
    const existingTextarea = existingHost.shadowRoot.querySelector<HTMLTextAreaElement>('#neotalk-extension-selection-text');
    const existingSendButton = existingHost.shadowRoot.querySelector<HTMLButtonElement>('#neotalk-extension-selection-send');
    const existingHeader = existingHost.shadowRoot.querySelector<HTMLElement>('.neotalk-extension-panel-header');
    const existingVideo = existingHost.shadowRoot.querySelector<HTMLVideoElement>('#neotalk-extension-avatar-video');
    const existingCaption = existingHost.shadowRoot.querySelector<HTMLElement>('#neotalk-extension-caption');
    const existingStatus = existingHost.shadowRoot.querySelector<HTMLElement>('#neotalk-extension-status');
    const existingMenuButton = existingHost.shadowRoot.querySelector<HTMLButtonElement>('#neotalk-extension-menu');
    const existingActions = existingHost.shadowRoot.querySelector<HTMLElement>('#neotalk-extension-actions');
    const existingTabAudioButton = existingHost.shadowRoot.querySelector<HTMLButtonElement>('#neotalk-extension-tab-audio');
    if (existingTooltip && existingPanel && existingTextarea && existingSendButton && existingHeader && existingVideo && existingCaption && existingStatus && existingMenuButton && existingActions && existingTabAudioButton) {
      return { tooltip: existingTooltip, panel: existingPanel, textarea: existingTextarea, sendButton: existingSendButton, header: existingHeader, video: existingVideo, caption: existingCaption, status: existingStatus, menuButton: existingMenuButton, actions: existingActions, tabAudioButton: existingTabAudioButton };
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
        background: linear-gradient(135deg, #1447e6, #7c3aed);
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
        border: 1px solid rgba(20, 71, 230, .18);
        border-radius: 18px;
        background: #ffffff;
        color: #0f172a;
        box-shadow: 0 18px 48px rgba(15, 23, 42, .24);
        overflow: hidden;
        font: 14px Arial, Helvetica, sans-serif;
      }
      .neotalk-extension-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        background: linear-gradient(135deg, #1447e6, #7c3aed);
        color: #ffffff;
        font-weight: 800;
        cursor: move;
        user-select: none;
      }
      .neotalk-extension-panel-title { display: inline-flex; align-items: center; gap: 8px; }
      #neotalk-extension-menu { border: 0; border-radius: 999px; width: 30px; height: 30px; background: rgba(255,255,255,.18); color: #fff; cursor: pointer; font-size: 18px; line-height: 1; }
      .neotalk-extension-panel-body { display: grid; gap: 8px; padding: 12px; }
      .neotalk-extension-avatar-box { min-height: 150px; border-radius: 14px; overflow: hidden; background: #0f172a; display: flex; align-items: center; justify-content: center; }
      #neotalk-extension-avatar-video { width: 100%; height: auto; max-height: 210px; display: block; background: #000; }
      #neotalk-extension-avatar-placeholder { margin: 0; padding: 14px; color: #e2e8f0; text-align: center; font-size: 13px; }
      #neotalk-extension-caption { min-height: 34px; padding: 8px; border-radius: 10px; background: #f8fafc; border: 1px solid #cbd5e1; color: #0f172a; line-height: 1.35; }
      #neotalk-extension-status { min-height: 18px; color: #475569; font-size: 12px; }
      #neotalk-extension-actions[hidden] { display: none; }
      #neotalk-extension-actions { display: grid; gap: 8px; }
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
      #neotalk-extension-selection-send, #neotalk-extension-tab-audio {
        border: 0;
        border-radius: 12px;
        padding: 10px 12px;
        background: #1447e6;
        color: #ffffff;
        font-weight: 800;
        cursor: pointer;
      }
      .neotalk-extension-helper { margin: 0; color: #475569; font-size: 12px; line-height: 1.35; }
      .${TOOLTIP_CLASS}:focus-visible, #neotalk-extension-selection-text:focus-visible, #neotalk-extension-selection-send:focus-visible, #neotalk-extension-menu:focus-visible, #neotalk-extension-tab-audio:focus-visible {
        outline: 3px solid #facc15;
        outline-offset: 2px;
      }
    </style>
    <button class="${TOOLTIP_CLASS}" type="button" aria-label="Traduzir texto selecionado para Libras">Traduzir para Libras</button>
    <aside class="${PANEL_CLASS}" aria-label="NeoTalk modo seleção">
      <div class="neotalk-extension-panel-header"><span class="neotalk-extension-panel-title">NeoTalk seleção <small>arraste</small></span><button id="neotalk-extension-menu" type="button" aria-label="Abrir ações">⋯</button></div>
      <div class="neotalk-extension-panel-body">
        <div class="neotalk-extension-avatar-box">
          <video id="neotalk-extension-avatar-video" autoplay muted loop controls playsinline></video>
          <p id="neotalk-extension-avatar-placeholder">Avatar aguardando tradução.</p>
        </div>
        <div id="neotalk-extension-caption" aria-live="polite">Selecione um texto na página...</div>
        <div id="neotalk-extension-status" aria-live="polite"></div>
        <textarea id="neotalk-extension-selection-text" aria-label="Texto selecionado para traduzir" placeholder="Selecione um texto na página..."></textarea>
        <button id="neotalk-extension-selection-send" type="button">Traduzir para Libras</button>
        <div id="neotalk-extension-actions" hidden>
          <button id="neotalk-extension-tab-audio" type="button">Ativar áudio da aba</button>
        </div>
        <p class="neotalk-extension-helper">Ao selecionar texto com o mouse, ele aparece aqui e é enviado automaticamente quando o modo seleção está ativo.</p>
      </div>
    </aside>
  `;

  return {
    tooltip: shadow.querySelector<HTMLButtonElement>(`.${TOOLTIP_CLASS}`)!,
    panel: shadow.querySelector<HTMLElement>(`.${PANEL_CLASS}`)!,
    textarea: shadow.querySelector<HTMLTextAreaElement>('#neotalk-extension-selection-text')!,
    sendButton: shadow.querySelector<HTMLButtonElement>('#neotalk-extension-selection-send')!,
    header: shadow.querySelector<HTMLElement>('.neotalk-extension-panel-header')!,
    video: shadow.querySelector<HTMLVideoElement>('#neotalk-extension-avatar-video')!,
    caption: shadow.querySelector<HTMLElement>('#neotalk-extension-caption')!,
    status: shadow.querySelector<HTMLElement>('#neotalk-extension-status')!,
    menuButton: shadow.querySelector<HTMLButtonElement>('#neotalk-extension-menu')!,
    actions: shadow.querySelector<HTMLElement>('#neotalk-extension-actions')!,
    tabAudioButton: shadow.querySelector<HTMLButtonElement>('#neotalk-extension-tab-audio')!
  };
}

const selectionUi = createSelectionUi();
selectionUi.tooltip.style.display = 'none';

function updatePanelVisibility(): void {
  selectionUi.panel.style.display = selectionModeEnabled ? 'block' : 'none';
}

function updateOverlayState(state: CaptionState): void {
  selectionUi.caption.textContent = state.caption || 'Selecione um texto na página...';
  selectionUi.status.textContent = state.error || state.status || '';
  if (state.fileUrl) {
    selectionUi.video.src = state.fileUrl;
    selectionUi.video.autoplay = true;
    selectionUi.video.muted = true;
    selectionUi.video.loop = true;
    selectionUi.video.controls = true;
    selectionUi.video.playsInline = true;
    const placeholder = selectionUi.video.parentElement?.querySelector<HTMLElement>('#neotalk-extension-avatar-placeholder');
    if (placeholder) placeholder.hidden = true;
    selectionUi.video.load();
    void selectionUi.video.play().catch(() => undefined);
  }
}

function loadOverlayState(): void {
  chrome.storage.local.get('neotalkCaptionState', (result) => {
    updateOverlayState((result.neotalkCaptionState as CaptionState | undefined) ?? {});
  });
}

function loadSelectionModePreference(): void {
  chrome.storage.sync.get('neotalkPreferences', (result) => {
    const preferences = result.neotalkPreferences as SelectionPreferences | undefined;
    selectionModeEnabled = preferences?.selectionModeEnabled ?? true;
    updatePanelVisibility();
  });
}

loadSelectionModePreference();
loadOverlayState();
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.neotalkPreferences) {
    const preferences = changes.neotalkPreferences.newValue as SelectionPreferences | undefined;
    selectionModeEnabled = preferences?.selectionModeEnabled ?? true;
    updatePanelVisibility();
  }
  if (areaName === 'local' && changes.neotalkCaptionState) {
    updateOverlayState((changes.neotalkCaptionState.newValue as CaptionState | undefined) ?? {});
  }
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
  if (selectionModeEnabled && lastAutoSubmittedPhrase !== frase) {
    lastAutoSubmittedPhrase = frase;
    sendSelectedPhrase(frase);
  }
}

function positionTooltipFromSelection(): void {
  window.clearTimeout(hideTimer);
  const selection = window.getSelection();
  const frase = getSelectedText();

  if (!frase || frase.trim().length === 0 || !selection || selection.rangeCount === 0) {
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
  sendSelectedPhrase(frase);
  hideTooltip();
});
selectionUi.sendButton.addEventListener('click', () => sendSelectedPhrase(selectionUi.textarea.value));
selectionUi.menuButton.addEventListener('mousedown', (event) => event.stopPropagation());
selectionUi.menuButton.addEventListener('click', () => { selectionUi.actions.hidden = !selectionUi.actions.hidden; });
selectionUi.tabAudioButton.addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'NEOTALK_START_TAB_AUDIO' });
  selectionUi.actions.hidden = true;
});
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
