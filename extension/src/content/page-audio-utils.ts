/**
 * Funções puras usadas por `page-audio.ts`, separadas para ficarem
 * testáveis sem depender de captura de mídia nem de storage.
 */

// captureStream() é suportado no Chrome mas não faz parte do lib.dom.d.ts do TypeScript.
declare global {
  interface HTMLMediaElement {
    captureStream?(): MediaStream;
  }
}

/** Id do host do balão. Fica aqui para `content-script.ts` e a busca por mídia usarem o mesmo valor. */
export const EXTENSION_HOST_ID = 'neotalk-extension-selection-host';

type RootLike = { host?: { id?: string } };

export type MediaCandidate = Pick<HTMLMediaElement, 'paused' | 'ended' | 'muted' | 'volume'> & {
  captureStream?: () => MediaStream;
  getRootNode?: () => unknown;
};

/**
 * O elemento é o avatar da própria extensão? Hoje o `<video>` do balão vive num
 * shadow root, que `document.querySelectorAll` não atravessa — mas depender
 * disso é frágil. Capturar o próprio avatar realimentaria a tradução.
 */
export function isInsideExtensionUi(element: MediaCandidate): boolean {
  const root = element.getRootNode?.() as RootLike | undefined;
  return root?.host?.id === EXTENSION_HOST_ID;
}

/**
 * Elegível para captura: tocando, sem estar mudo, com volume audível, com
 * suporte a `captureStream()` e fora da UI da extensão.
 */
export function isEligibleMediaElement(element: MediaCandidate): boolean {
  if (isInsideExtensionUi(element)) return false;
  return !element.paused && !element.ended && !element.muted && element.volume > 0 && typeof element.captureStream === 'function';
}

type TrackLike = { readyState: string };

/**
 * Só as faixas ainda vivas. O Chrome devolve o **mesmo** `MediaStream` a cada
 * `captureStream()` do mesmo elemento: se uma captura anterior encerrou as
 * faixas, elas continuam na lista como `ended` e gravá-las falharia. Contar o
 * tamanho da lista não basta.
 */
export function pickLiveAudioTracks<T extends TrackLike>(tracks: readonly T[]): T[] {
  return tracks.filter((track) => track.readyState === 'live');
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
