import type { RuntimeMessage } from '../shared/types.js';

const TOOLTIP_CLASS = 'neotalk-extension-tooltip';
const tooltip = document.createElement('button');
tooltip.type = 'button';
tooltip.className = TOOLTIP_CLASS;
tooltip.textContent = 'Traduzir para Libras';
tooltip.style.display = 'none';
tooltip.setAttribute('aria-label', 'Traduzir texto selecionado para Libras');
document.documentElement.appendChild(tooltip);

const style = document.createElement('style');
style.textContent = `
  .${TOOLTIP_CLASS} {
    position: fixed;
    z-index: 2147483647;
    max-width: 220px;
    border: 0;
    border-radius: 999px;
    padding: 8px 12px;
    background: #1447e6;
    color: #ffffff;
    font: 700 13px Arial, Helvetica, sans-serif;
    cursor: pointer;
    box-shadow: 0 8px 24px rgba(15, 23, 42, .25);
  }
  .${TOOLTIP_CLASS}:focus-visible {
    outline: 3px solid #facc15;
    outline-offset: 2px;
  }
`;
document.documentElement.appendChild(style);

function hideTooltip(): void {
  tooltip.style.display = 'none';
}

function getSelectedText(): string {
  return window.getSelection()?.toString().trim() ?? '';
}

document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  const frase = getSelectedText();

  if (!frase || frase.trim().length === 0 || !selection || selection.rangeCount === 0) {
    hideTooltip();
    return;
  }

  const rect = selection.getRangeAt(0).getBoundingClientRect();
  tooltip.dataset.frase = frase;
  tooltip.style.left = `${Math.max(8, rect.left)}px`;
  tooltip.style.top = `${Math.min(window.innerHeight - 44, Math.max(8, rect.bottom + 8))}px`;
  tooltip.style.display = 'block';
});

tooltip.addEventListener('click', () => {
  const frase = tooltip.dataset.frase ?? getSelectedText();
  if (!frase || frase.trim().length === 0) return;

  const message: RuntimeMessage = { type: 'NEOTALK_SUBMIT_PHRASE', frase, source: 'selection' };
  void chrome.runtime.sendMessage(message);
  hideTooltip();
});

window.addEventListener('scroll', hideTooltip, { passive: true });
