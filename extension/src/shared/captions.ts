import type { CaptionState } from './types.js';

/**
 * Junta o texto já confirmado com o que ainda está sendo reconhecido, como o
 * balão faz em `renderCaption` (`content-script.ts`). Sem a prévia, quem
 * acompanha pelo popup via a tela parada entre uma frase e outra, enquanto o
 * balão na mesma aba já mostrava o texto crescendo.
 */
export function renderCaptionState(captionElement: HTMLElement, statusElement: HTMLElement, state: CaptionState): void {
  const confirmed = state.caption ?? '';
  const preview = state.partialCaption ?? '';
  captionElement.textContent = '';

  if (!confirmed && !preview) {
    captionElement.textContent = 'Digite ou selecione um texto para traduzir.';
  } else {
    if (confirmed) captionElement.append(confirmed);
    if (preview) {
      const previewNode = document.createElement('span');
      previewNode.className = 'neotalk-extension-caption-partial';
      previewNode.textContent = confirmed ? ` ${preview}` : preview;
      captionElement.append(previewNode);
    }
  }

  statusElement.textContent = state.error || state.status || '';
}
