/**
 * Códigos de erro internos, trocados entre contextos da extensão via
 * `error.message`. Não são texto para o usuário — cada lado decide a
 * mensagem exibida a partir do código.
 */
export const MICROPHONE_PERMISSION_REQUIRED = 'microphone-permission-required';
export const NO_MEDIA_ELEMENT = 'no-media-element';
/**
 * `getUserMedia` não respondeu dentro do prazo — mesmo com a permissão já
 * concedida, observado travando para sempre num documento offscreen em
 * algumas máquinas. Distinto de `MICROPHONE_PERMISSION_REQUIRED`: mandar de
 * volta para a página de autorização não ajuda quem já autorizou.
 */
export const MICROPHONE_TIMEOUT = 'microphone-timeout';
