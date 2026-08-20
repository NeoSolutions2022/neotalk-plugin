export const MESSAGES = {
  processing: 'Processando tradução…',
  listening: 'Ouvindo áudio…',
  transcribing: 'Transcrevendo…',
  empty: 'Digite ou selecione um texto para traduzir.',
  speechUnsupported: 'Seu navegador não suporta reconhecimento de voz.',
  microphoneStartFailed: 'Não foi possível iniciar o microfone agora. Tente novamente.',
  microphonePermissionRequired: 'Autorize o microfone na página de Configurações da extensão (abrindo agora) e tente de novo.',
  microphoneTimeout: 'O microfone não respondeu a tempo. Verifique se outro programa não está usando o microfone e se o sistema operacional permite que o Chrome o acesse, depois tente de novo.',
  tabAudioUnsupported: 'Seu navegador não permite capturar diretamente o áudio desta aba. Use o microfone ou compartilhe a aba quando solicitado.',
  tabAudioStartFailed: 'Não foi possível iniciar a captura da aba agora. Tente novamente.',
  noMediaElement: 'Não encontramos áudio tocando nesta página. Dê play num vídeo/áudio, ou use o popup da extensão para capturar a aba inteira.',
  chunkTranscriptionFailed: 'Um trecho do áudio não pôde ser transcrito.',
  translationError: 'Não foi possível traduzir agora. Tente novamente.',
  nothingToTranslate: 'Não há texto traduzível na seleção.'
} as const;

/**
 * Texto para o usuário a partir de um erro de captura. Os códigos conhecidos
 * (`shared/errors.ts`) viram orientação; qualquer outra coisa é detalhe técnico
 * — normalmente uma DOMException em inglês — e não deve chegar à tela: o
 * detalhe cru vai para o log de desenvolvedor, em Configurações.
 */
export function captureErrorMessage(error: string | undefined, mode: 'microphone' | 'tab'): string {
  if (!error) return '';
  // Repetidos aqui em vez de importados de `shared/errors.ts`: um import real
  // entre módulos de `extension/src` quebra o test runner do Node, que (ao
  // contrário do esbuild) não remapeia especificadores `.js` para os `.ts`
  // correspondentes. Mesma razão por trás de `content/page-audio-utils.ts`.
  if (error === 'no-media-element') return MESSAGES.noMediaElement;
  if (error === 'microphone-permission-required') return MESSAGES.microphonePermissionRequired;
  if (error === 'microphone-timeout') return MESSAGES.microphoneTimeout;
  // Mensagem já pronta para o usuário (o service worker traduz antes de responder).
  if (Object.values(MESSAGES).includes(error as (typeof MESSAGES)[keyof typeof MESSAGES])) return error;
  return mode === 'microphone' ? MESSAGES.microphoneStartFailed : MESSAGES.tabAudioStartFailed;
}
