/**
 * Decide onde cortar a gravação, a partir da energia do sinal.
 *
 * A captura cortava em blocos fixos de 15 segundos. Isso trazia três
 * problemas: até 15 s de espera antes de uma frase começar a ser transcrita,
 * corte no meio de palavras, e blocos de puro silêncio indo para o Whisper —
 * que é a origem das alucinações do tipo "obrigado por assistir".
 *
 * Aqui o corte acontece na pausa natural da fala, e blocos sem fala nenhuma
 * são descartados antes de chegar ao modelo.
 *
 * Módulo puro e baseado em tempo — sem áudio nem `chrome` — para ser testável
 * de forma determinística.
 */

export type SegmenterOptions = {
  /** Energia RMS a partir da qual o sinal conta como fala. */
  threshold?: number;
  /** Silêncio que fecha o trecho, em milissegundos. */
  silenceMs?: number;
  /** Fala mínima para o trecho valer transcrição. */
  minSpeechMs?: number;
  /** Corte forçado, para quem fala sem pausa não gerar um bloco infinito. */
  maxSegmentMs?: number;
  /** Tempo em silêncio total antes de reciclar a gravação e descartá-la. */
  idleFlushMs?: number;
};

const DEFAULTS: Required<SegmenterOptions> = {
  threshold: 0.012,
  silenceMs: 700,
  minSpeechMs: 350,
  // Rede de segurança para fala corrida. Eram 20 s: quem falava sem pausa
  // ficava vinte segundos sem ver nada na tela, porque só o fechamento do
  // trecho manda o áudio para o modelo. As prévias já cobrem esse intervalo,
  // mas o texto definitivo (o que vira tradução) não pode depender delas.
  maxSegmentMs: 5_000,
  idleFlushMs: 30_000
};

/** `hadSpeech: false` significa descartar o bloco sem transcrever. */
export type SegmentEnd = (hadSpeech: boolean) => void;

export class SpeechSegmenter {
  private readonly onSegmentEnd: SegmentEnd;
  private readonly settings: Required<SegmenterOptions>;
  private segmentStart: number | null = null;
  private speechMs = 0;
  private lastVoiceAt: number | null = null;
  private lastPush: number | null = null;

  constructor(onSegmentEnd: SegmentEnd, options: SegmenterOptions = {}) {
    this.onSegmentEnd = onSegmentEnd;
    this.settings = { ...DEFAULTS, ...options };
  }

  get speaking(): boolean {
    return this.lastVoiceAt !== null;
  }

  /** Recebe a energia medida do sinal no instante `now`. */
  push(level: number, now: number): void {
    if (this.segmentStart === null) this.segmentStart = now;
    const elapsed = this.lastPush === null ? 0 : now - this.lastPush;
    this.lastPush = now;

    if (level >= this.settings.threshold) {
      this.speechMs += elapsed;
      this.lastVoiceAt = now;
    }

    const silenceClosed = this.lastVoiceAt !== null && now - this.lastVoiceAt >= this.settings.silenceMs;
    const tooLong = now - this.segmentStart >= this.settings.maxSegmentMs;
    // Nada além de silêncio há muito tempo: recicla a gravação para o buffer
    // não crescer sem limite, mas sem mandar nada ao modelo.
    const idleTooLong = this.lastVoiceAt === null && now - this.segmentStart >= this.settings.idleFlushMs;

    if (silenceClosed || tooLong || idleTooLong) this.end(now);
  }

  /** Fecha o trecho atual. Usado também ao parar a captura. */
  end(now: number): void {
    const hadSpeech = this.speechMs >= this.settings.minSpeechMs;
    this.reset(now);
    this.onSegmentEnd(hadSpeech);
  }

  reset(now: number | null = null): void {
    this.segmentStart = now;
    this.lastPush = now;
    this.speechMs = 0;
    this.lastVoiceAt = null;
  }
}

/** Energia média do bloco de amostras. */
export function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) total += sample * sample;
  return Math.sqrt(total / samples.length);
}
