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

/**
 * O `POST /api/v1/mvp/sign` do Avatar3D mais o polling do widget levam de 7 a 9 s
 * para preparar uma pose — e o widget NÃO corta a animação em curso quando recebe
 * um `neotalk:sign` novo, só troca quando a pose nova fica pronta. Por isso a
 * próxima frase pode ser pedida ANTES do fim do sinal atual: o preparo roda em
 * paralelo com o que já está tocando, e some quase todo o tempo morto entre uma
 * frase e outra. Calibrado com folga sobre os ~7 s observados — se cortar o fim
 * de um sinal na prática, este número está alto demais.
 */
export const PIPELINE_LEAD_MS = 5_000;
/** Piso do tempo de exibição, para sinais curtos não virarem rajada. */
export const MIN_HOLD_MS = 800;

/** Quando a duração real não pôde ser obtida, este palpite por sinal entra no lugar. */
export const FALLBACK_MS_PER_WORD = 1_200;
export const FALLBACK_MIN_MS = 1_500;
export const FALLBACK_MAX_MS = 12_000;

export type EnqueueResult = 'queued' | 'duplicate';

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

/** Tempo de espera antes de liberar a próxima, sobrepondo o preparo dela com o fim da atual. */
export function overlapDelay(durationMs: number): number {
  return Math.max(MIN_HOLD_MS, durationMs - PIPELINE_LEAD_MS);
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
  /** A frase que está tocando (ou sendo preparada) agora, para detectar repetição. */
  private current: string | null = null;

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

  /**
   * Enfileira, a menos que a frase já esteja tocando ou já esperando na fila.
   *
   * Sem isto, clicar várias vezes na mesma frase (natural quando a resposta
   * demora 7-9 s e nada na tela confirma o primeiro clique) empilhava cópias —
   * foi o que fez o avatar repetir a mesma palavra por mais de um minuto num
   * teste real. O chamador usa o retorno para avisar quando descartou.
   */
  enqueue(phrase: string): EnqueueResult {
    const trimmed = phrase.trim();
    if (!trimmed) return 'duplicate';
    if (trimmed === this.current || this.pending.includes(trimmed)) return 'duplicate';

    this.pending.push(trimmed);
    while (this.pending.length > MAX_QUEUED_PHRASES) {
      this.pending.shift();
      this.droppedCount += 1;
    }
    this.pump();
    return 'queued';
  }

  /**
   * O widget começou a reproduzir. A duração real decide quando a próxima frase
   * é liberada — sobrepondo o preparo dela com o fim da atual (`overlapDelay`),
   * em vez de esperar a reprodução terminar por inteiro.
   */
  onPlaying(taskId: string | undefined, wordCount: number): void {
    const generation = this.generation;
    void this.options.resolveDuration(taskId).then(
      (duration) => this.scheduleNext(generation, overlapDelay(duration ?? fallbackDuration(wordCount))),
      () => this.scheduleNext(generation, overlapDelay(fallbackDuration(wordCount)))
    );
  }

  /**
   * Falhou. A frase em curso é perdida e a fila segue — uma falha de rede ou uma
   * frase que o servidor recusou não pode deixar as seguintes presas para sempre.
   */
  onError(): void {
    this.generation += 1;
    this.clearTimer();
    this.current = null;
    this.busy = false;
    this.pump();
  }

  /** Encerra a fila e esquece o que estava pendente (balão fechando). */
  reset(): void {
    this.generation += 1;
    this.clearTimer();
    this.pending.length = 0;
    this.droppedCount = 0;
    this.current = null;
    this.busy = false;
    this.ready = false;
  }

  private scheduleNext(generation: number, delayMs: number): void {
    if (generation !== this.generation) return;
    this.clearTimer();
    this.cancelTimer = this.options.schedule(() => {
      this.cancelTimer = null;
      if (generation !== this.generation) return;
      this.current = null;
      this.busy = false;
      this.pump();
    }, Math.max(0, delayMs));
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
    this.current = next;
    this.generation += 1;
    this.options.send(next);
  }
}
