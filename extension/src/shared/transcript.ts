// Casar caracteres de controle e o objetivo desta expressao: eles chegam da
// transcricao e quebram a resposta da API.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const ONLY_PUNCTUATION = /^[\p{P}\p{S}\s]+$/u;
const KNOWN_SILENCE_ARTIFACTS = new Set(['[silêncio]', '(silêncio)', '[música]', '(música)', 'obrigado por assistir']);

export function normalizeTranscript(rawText: string, previousText = ''): string {
  let text = rawText.normalize('NFC').replace(CONTROL_CHARACTERS, '').replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
  if (!text || ONLY_PUNCTUATION.test(text) || KNOWN_SILENCE_ARTIFACTS.has(text.toLocaleLowerCase('pt-BR'))) return '';

  const previousWords = previousText.trim().split(/\s+/).filter(Boolean);
  const currentWords = text.split(/\s+/);
  const maxOverlap = Math.min(8, previousWords.length, currentWords.length);
  for (let size = maxOverlap; size >= 2; size -= 1) {
    const previousEnd = previousWords.slice(-size).join(' ').toLocaleLowerCase('pt-BR');
    const currentStart = currentWords.slice(0, size).join(' ').toLocaleLowerCase('pt-BR');
    if (previousEnd === currentStart) {
      text = currentWords.slice(size).join(' ').trim();
      break;
    }
  }
  return text;
}
