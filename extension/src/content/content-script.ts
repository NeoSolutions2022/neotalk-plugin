type NeoTalkSelectionMessage = {
  type: 'NEOTALK_SUBMIT_PHRASE';
  frase: string;
  source: 'selection';
};

const HOST_ID = 'neotalk-extension-selection-host';
const TOOLTIP_CLASS = 'neotalk-extension-tooltip';
let selectedPhrase = '';
let hideTimer: number | undefined;

function createTooltip(): HTMLButtonElement {
  const existingHost = document.getElementById(HOST_ID);
  if (existingHost?.shadowRoot) {
    const existingTooltip = existingHost.shadowRoot.querySelector<HTMLButtonElement>(`.${TOOLTIP_CLASS}`);
    if (existingTooltip) return existingTooltip;
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
      .${TOOLTIP_CLASS}:focus-visible {
        outline: 3px solid #facc15;
        outline-offset: 2px;
      }
    </style>
    <button class="${TOOLTIP_CLASS}" type="button" aria-label="Traduzir texto selecionado para Libras">Traduzir para Libras</button>
  `;

  return shadow.querySelector<HTMLButtonElement>(`.${TOOLTIP_CLASS}`)!;
}

const tooltip = createTooltip();
tooltip.style.display = 'none';

function hideTooltip(): void {
  tooltip.style.display = 'none';
}

function getSelectedText(): string {
  return window.getSelection()?.toString().trim() ?? '';
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

  selectedPhrase = frase;
  tooltip.style.left = `${Math.min(window.innerWidth - 252, Math.max(8, rect.left))}px`;
  tooltip.style.top = `${Math.min(window.innerHeight - 48, Math.max(8, rect.bottom + 8))}px`;
  tooltip.style.display = 'block';
}

document.addEventListener('selectionchange', () => {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(positionTooltipFromSelection, 80);
});
document.addEventListener('mouseup', () => window.setTimeout(positionTooltipFromSelection, 0), true);
document.addEventListener('keyup', (event) => {
  if (event.key === 'Shift' || event.key.startsWith('Arrow')) window.setTimeout(positionTooltipFromSelection, 0);
}, true);

tooltip.addEventListener('mousedown', (event) => event.preventDefault());
tooltip.addEventListener('click', () => {
  const frase = selectedPhrase || getSelectedText();
  if (!frase || frase.trim().length === 0) return;

  const message: NeoTalkSelectionMessage = { type: 'NEOTALK_SUBMIT_PHRASE', frase, source: 'selection' };
  void chrome.runtime.sendMessage(message);
  hideTooltip();
});

window.addEventListener('scroll', hideTooltip, { passive: true });
window.addEventListener('resize', hideTooltip, { passive: true });
