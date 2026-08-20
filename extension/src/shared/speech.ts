/**
 * Tipos da Web Speech API do Chrome (`webkitSpeechRecognition`), que o
 * TypeScript não traz por padrão.
 *
 * É ela que dá transcrição ao vivo de verdade no microfone: com
 * `interimResults`, cada palavra reconhecida chega em ~200 ms e vai sendo
 * corrigida até a frase fechar. O Whisper não faz isso — só devolve texto
 * quando termina de processar um bloco inteiro.
 *
 * A contrapartida é que ela **sempre escuta o microfone do sistema** e não
 * aceita um `MediaStream`, então não serve para o áudio de uma aba. Daí a
 * divisão: Web Speech no microfone, Whisper no áudio da aba.
 */

export type SpeechRecognitionAlternative = { transcript: string; confidence: number };

export type SpeechRecognitionResult = {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
};

export type SpeechRecognitionResultList = {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
};

export type SpeechRecognitionEvent = {
  /** Índice do primeiro resultado novo — os anteriores já foram entregues. */
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
};

export type SpeechRecognitionErrorEvent = {
  /** 'no-speech' | 'aborted' | 'audio-capture' | 'not-allowed' | 'network' | … */
  readonly error: string;
  readonly message?: string;
};

export type SpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

export type SpeechRecognitionConstructor = new () => SpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}
