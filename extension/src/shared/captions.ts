import type { CaptionState } from './types.js';

export function renderCaptionState(captionElement: HTMLElement, statusElement: HTMLElement, state: CaptionState): void {
  captionElement.textContent = state.caption || 'Digite ou selecione um texto para traduzir.';
  statusElement.textContent = state.error || state.status || '';
}
