/**
 * Normalização de frases antes de enviar para a API NeoTalk.
 *
 * A API recebe `frase` e devolve um vídeo em Libras. Caracteres que ela não
 * sabe glosar (emoji, símbolos, URLs, caracteres de controle vindos da
 * transcrição) fazem a tradução voltar incompleta ou com erro. Este módulo é
 * puro — não depende de `chrome` — justamente para poder ser testado no Node.
 */

// Casar caracteres de controle e justamente o objetivo aqui: eles chegam da
// transcricao e da selecao de paginas, e quebram a resposta da API.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const PICTOGRAPHIC = /\p{Extended_Pictographic}[\uFE0E\uFE0F]?/gu;
const REGIONAL_INDICATOR = /[\u{1F1E6}-\u{1F1FF}]/gu;
const URLS = /\b(?:https?:\/\/|www\.)\S+/gi;
const EMAILS = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi;
const MULTIPLE_SPACES = /\s+/g;

const SMART_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"'],
  [/[\u2018\u2019\u201A\u2039\u203A]/g, "'"],
  [/[\u2010-\u2015\u2212]/g, '-'],
  [/\u2026/g, '...'],
  [/\u00A0/g, ' ']
];

export type SanitizeOptions = {
  /** Limite de caracteres enviados à API. */
  maxChars?: number;
  /** Remove URLs e e-mails, que não têm glosa em Libras. */
  removeUrls?: boolean;
  /**
   * Escreve números por extenso ("42" -> "quarenta e dois").
   * Desligado por padrão: só ligue depois de confirmar como a API real trata
   * dígitos, para não trocar um comportamento que já funciona.
   */
  expandNumbers?: boolean;
  /** Remove pontuação, mantendo apenas letras, dígitos e espaços. */
  stripPunctuation?: boolean;
};

const DEFAULTS: Required<SanitizeOptions> = {
  maxChars: 4000,
  removeUrls: true,
  expandNumbers: false,
  stripPunctuation: false
};

const UNITS = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'];
const TEENS = ['dez', 'onze', 'doze', 'treze', 'catorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const HUNDREDS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
const SCALES: ReadonlyArray<readonly [number, string, string]> = [
  [1_000_000_000, 'bilhão', 'bilhões'],
  [1_000_000, 'milhão', 'milhões'],
  [1_000, 'mil', 'mil']
];

function belowThousand(value: number): string {
  if (value === 100) return 'cem';

  const parts: string[] = [];
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;

  if (hundreds > 0) parts.push(HUNDREDS[hundreds]);

  if (rest >= 20) {
    const tens = Math.floor(rest / 10);
    const units = rest % 10;
    parts.push(units > 0 ? `${TENS[tens]} e ${UNITS[units]}` : TENS[tens]);
  } else if (rest >= 10) {
    parts.push(TEENS[rest - 10]);
  } else if (rest > 0) {
    parts.push(UNITS[rest]);
  }

  return parts.join(' e ');
}

/** Escreve um inteiro por extenso em português do Brasil. */
export function numberToWords(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (value < 0) return `menos ${numberToWords(Math.abs(value))}`;

  const integer = Math.trunc(value);
  if (integer === 0) return 'zero';
  if (integer < 1000) return belowThousand(integer);

  for (const [scale, singular, plural] of SCALES) {
    if (integer < scale) continue;

    const count = Math.floor(integer / scale);
    const rest = integer % scale;
    const prefix = scale === 1_000 && count === 1 ? 'mil' : `${numberToWords(count)} ${count === 1 ? singular : plural}`;
    if (rest === 0) return prefix;

    // "mil e duzentos", mas "mil duzentos e trinta".
    const separator = rest < 100 || rest % 100 === 0 ? ' e ' : ' ';
    return `${prefix}${separator}${numberToWords(rest)}`;
  }

  return String(integer);
}

function expandNumericTokens(text: string): string {
  return text
    .replace(/(\d+)\s*%/g, (_match, digits: string) => `${numberToWords(Number(digits))} por cento`)
    .replace(/\d+(?:[.,]\d+)?/g, (match) => {
      const [integerPart, fractionPart] = match.split(/[.,]/);
      const integerWords = numberToWords(Number(integerPart));
      if (fractionPart === undefined) return integerWords;
      const fractionWords = [...fractionPart].map((digit) => UNITS[Number(digit)]).join(' ');
      return `${integerWords} vírgula ${fractionWords}`;
    });
}

/**
 * Devolve a frase pronta para a API, ou string vazia se não sobrar conteúdo
 * traduzível (por exemplo, uma seleção que era só um emoji).
 */
export function sanitizePhrase(raw: string, options: SanitizeOptions = {}): string {
  if (typeof raw !== 'string') return '';

  const settings = { ...DEFAULTS, ...options };
  let text = raw.normalize('NFC');

  text = text.replace(CONTROL_CHARS, ' ').replace(ZERO_WIDTH, '');
  for (const [pattern, replacement] of SMART_REPLACEMENTS) text = text.replace(pattern, replacement);
  if (settings.removeUrls) text = text.replace(URLS, ' ').replace(EMAILS, ' ');
  text = text.replace(REGIONAL_INDICATOR, ' ').replace(PICTOGRAPHIC, ' ');
  if (settings.expandNumbers) text = expandNumericTokens(text);
  if (settings.stripPunctuation) text = text.replace(/[^\p{L}\p{N}\s]/gu, ' ');

  text = text.replace(MULTIPLE_SPACES, ' ').trim();
  if (text.length > settings.maxChars) {
    const cut = text.slice(0, settings.maxChars);
    const lastSpace = cut.lastIndexOf(' ');
    text = (lastSpace > settings.maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
  }

  // Sobrou só pontuação ou símbolo: não há o que traduzir.
  return /\p{L}|\p{N}/u.test(text) ? text : '';
}
