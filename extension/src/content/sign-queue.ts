/**
 * Fila das frases que vão virar sinal no avatar 3D.
 *
 * Existe porque o widget **não avisa quando termina de reproduzir**. Os eventos
 * que ele manda são `neotalk:ready`, `neotalk:status`, `neotalk:playing` — que
 * dispara quando a reprodução COMEÇA — e `neotalk:error`. Mandar um
 * `neotalk:sign` novo cancela o anterior no meio, então, sem fila, a transcrição
 * ao vivo (que produz uma frase a cada poucos segundos) faria o avatar recomeçar
 * sem nunca completar sinal nenhum.
 *
 * A duração é calculada: `neotalk:playing` traz o `taskId`, e a task devolve a
 * pose com `frame_count` e `fps`. Quem busca isso é o chamador, por
 * `resolveDuration` — este módulo fica puro, sem `chrome`, sem DOM e sem rede,
 * no mesmo espírito de `offscreen/speech-segmenter.ts` e `shared/capture-guard.ts`,
 * para ser testável de forma determinística.
 */

/**
 * Teto da fila. Numa fala corrida a transcrição produz frase atrás de frase e o
 * avatar, que reproduz em tempo real, fica cada vez mais para trás. Passando
 * disso, as mais antigas são descartadas — é melhor o avatar acompanhar o assunto
 * atual do que sinalizar fielmente o que foi dito minutos antes.
 */
export const MAX_QUEUED_PHRASES = 10;

/** Folga entre o fim estimado de um sinal e o envio do próximo. */
export const GAP_MS = 250;

/** Quando a duração real não pôde ser obtida, este palpite por sinal entra no lugar. */
export const FALLBACK_MS_PER_WORD = 1_200;
export const FALLBACK_MIN_MS = 1_500;
export const FALLBACK_MAX_MS = 12_000;

export type SignQueueOptions = {
  /** Manda a frase ao widget. */
  send: (phrase: string) => void;
  /** Agenda `run` para daqui a `delayMs`; devolve um cancelador. */
  schedule: (run: () => void, delayMs: number) => () => void;
  /**
   * Duração real do sinal em curso, em milissegundos, ou `null` quando não deu
   * para descobrir. O chamador busca a task pelo `taskId`.
   */
  resolveDuration: (taskId: string | undefined) => Promise<number | null>;
};

export function fallbackDuration(wordCount: number): number {
  const estimate = Math.max(1, wordCount) * FALLBACK_MS_PER_WORD;
  return Math.min(FALLBACK_MAX_MS, Math.max(FALLBACK_MIN_MS, estimate));
}

export class SignQueue {
  private readonly options: SignQueueOptions;
  private readonly pending: string[] = [];
  private ready = false;
  private busy = false;
  private cancelTimer: (() => void) | null = null;
  /** Cresce a cada sinal; descarta a conclusão de um sinal já substituído. */
  private generation = 0;
  /** Frases descartadas por excesso, para o balão poder avisar. */
  private droppedCount = 0;

  constructor(options: SignQueueOptions) {
    this.options = options;
  }

  get size(): number {
    return this.pending.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  /** O avatar terminou de carregar e já aceita comandos. */
  onReady(): void {
    this.ready = true;
    this.pump();
  }

  enqueue(phrase: string): void {
    const trimmed = phrase.trim();
    if (!trimmed) return;
    this.pending.push(trimmed);
    while (this.pending.length > MAX_QUEUED_PHRASES) {
      this.pending.shift();
      this.droppedCount += 1;
    }
    this.pump();
  }

  /**
   * O widget começou a reproduzir. A partir daqui o relógio corre: quando a
   * duração passar, a próxima frase pode entrar.
   */
  onPlaying(taskId: string | undefined, wordCount: number): void {
    const generation = this.generation;
    void this.options.resolveDuration(taskId).then(
      (duration) => this.scheduleNext(generation, duration ?? fallbackDuration(wordCount)),
      () => this.scheduleNext(generation, fallbackDuration(wordCount))
    );
  }

  /**
   * Falhou. A frase em curso é perdida e a fila segue — uma falha de rede ou uma
   * frase que o servidor recusou não pode deixar as seguintes presas para sempre.
   */
  onError(): void {
    this.generation += 1;
    this.clearTimer();
    this.busy = false;
    this.pump();
  }

  /** Encerra a fila e esquece o que estava pendente (balão fechando). */
  reset(): void {
    this.generation += 1;
    this.clearTimer();
    this.pending.length = 0;
    this.droppedCount = 0;
    this.busy = false;
    this.ready = false;
  }

  private scheduleNext(generation: number, delayMs: number): void {
    if (generation !== this.generation) return;
    this.clearTimer();
    this.cancelTimer = this.options.schedule(() => {
      this.cancelTimer = null;
      if (generation !== this.generation) return;
      this.busy = false;
      this.pump();
    }, Math.max(0, delayMs) + GAP_MS);
  }

  private clearTimer(): void {
    if (this.cancelTimer) this.cancelTimer();
    this.cancelTimer = null;
  }

  private pump(): void {
    if (!this.ready || this.busy) return;
    const next = this.pending.shift();
    if (next === undefined) return;
    this.busy = true;
    this.generation += 1;
    this.options.send(next);
  }
}
