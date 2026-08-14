/**
 * Regras de transição do estado de captura.
 *
 * O estado (`AudioCaptureState`) já existia; o que faltava eram as garantias
 * que impedem a interface de travar:
 *
 * - clique duplo não abre um segundo stream;
 * - parar funciona no meio de uma inicialização;
 * - uma confirmação atrasada não ressuscita captura já encerrada;
 * - transição que nunca recebeu confirmação é considerada travada — o service
 *   worker do MV3 é encerrado por inatividade e deixaria o botão vermelho sem
 *   nada estar gravando.
 *
 * Módulo puro, sem `chrome`, para as regras serem testáveis sem navegador.
 */
import type { AudioCaptureMode, AudioCapturePhase, AudioCaptureState } from './types.js';

/** Tempo máximo numa fase de transição antes de considerar travada. */
export const STALE_TRANSITION_MS = 20_000;

const TRANSITIONAL: readonly AudioCapturePhase[] = ['starting', 'loading-model', 'stopping'];
const RUNNING: readonly AudioCapturePhase[] = ['starting', 'loading-model', 'recording', 'transcribing'];
/** Fases em que a fonte ainda está ocupada — inclui o encerramento em curso. */
const BUSY: readonly AudioCapturePhase[] = [...RUNNING, 'stopping'];

/** Fases em que o botão precisa ficar desabilitado. */
export function isTransitional(phase: AudioCapturePhase): boolean {
  return TRANSITIONAL.includes(phase);
}

/** Há captura em andamento (ou subindo)? */
export function isRunning(state: AudioCaptureState): boolean {
  return RUNNING.includes(state.phase);
}

/** Há captura em andamento, subindo ou encerrando? */
export function isBusy(state: AudioCaptureState): boolean {
  return BUSY.includes(state.phase);
}

/** O botão desta fonte deve sair do verde? */
export function isActiveFor(state: AudioCaptureState, mode: AudioCaptureMode, tabId?: number | null): boolean {
  if (!isBusy(state) || state.mode !== mode) return false;
  // Captura de aba pertence a uma aba específica; microfone é global.
  if (mode === 'tab' && tabId != null && state.tabId != null) return state.tabId === tabId;
  return true;
}

/**
 * A fonte pedida exige interromper a que está ativa? Devolve o modo a parar,
 * ou null quando o pedido pode seguir direto.
 */
export function conflictingMode(state: AudioCaptureState, requested: AudioCaptureMode): AudioCaptureMode | null {
  return isRunning(state) && state.mode != null && state.mode !== requested ? state.mode : null;
}

/** Transição pendente que nunca recebeu confirmação. */
export function isStale(state: AudioCaptureState, now: number): boolean {
  return isTransitional(state.phase) && now - state.updatedAt >= STALE_TRANSITION_MS;
}

/** Estado efetivo, já descartando transição travada. */
export function reconcile(state: AudioCaptureState, now: number): AudioCaptureState {
  return isStale(state, now) ? { phase: 'inactive', updatedAt: now } : state;
}

/**
 * Um pedido de início repetido para a fonte que já está subindo ou gravando é
 * ignorado: é o clique duplo que não pode abrir um segundo stream.
 */
export function shouldIgnoreStart(state: AudioCaptureState, requested: AudioCaptureMode, now: number): boolean {
  const current = reconcile(state, now);
  return isRunning(current) && current.mode === requested;
}

/** Parar sempre é aceito, exceto quando já não há nada rodando. */
export function shouldIgnoreStop(state: AudioCaptureState, now: number): boolean {
  const current = reconcile(state, now);
  return current.phase === 'inactive' || current.phase === 'stopping';
}

/**
 * Confirmação atrasada só vale para a sessão que ainda está no ar. Sem isto,
 * um "comecei" de uma sessão já encerrada reativaria a interface.
 */
export function acceptsUpdate(state: AudioCaptureState, sessionId: string | undefined): boolean {
  if (!sessionId || !state.sessionId) return true;
  return state.sessionId === sessionId;
}
