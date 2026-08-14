import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_TRANSITION_MS,
  acceptsUpdate,
  conflictingMode,
  isActiveFor,
  isStale,
  isTransitional,
  reconcile,
  shouldIgnoreStart,
  shouldIgnoreStop
} from '../extension/src/shared/capture-guard.ts';
import type { AudioCaptureState } from '../extension/src/shared/types.ts';

const state = (partial: Partial<AudioCaptureState> = {}): AudioCaptureState =>
  ({ phase: 'inactive', updatedAt: 1_000, ...partial });

test('botao fica desabilitado somente nas fases de transicao', () => {
  assert.equal(isTransitional('starting'), true);
  assert.equal(isTransitional('loading-model'), true);
  assert.equal(isTransitional('stopping'), true);
  assert.equal(isTransitional('recording'), false);
  assert.equal(isTransitional('transcribing'), false);
  assert.equal(isTransitional('inactive'), false);
  assert.equal(isTransitional('error'), false);
});

test('clique duplo na mesma fonte nao abre um segundo stream', () => {
  for (const phase of ['starting', 'loading-model', 'recording', 'transcribing'] as const) {
    assert.equal(shouldIgnoreStart(state({ phase, mode: 'tab' }), 'tab', 1_000), true, phase);
  }
  assert.equal(shouldIgnoreStart(state({ phase: 'inactive' }), 'tab', 1_000), false);
  assert.equal(shouldIgnoreStart(state({ phase: 'error', mode: 'tab' }), 'tab', 1_000), false, 'apos erro pode tentar de novo');
});

test('trocar de fonte nunca e ignorado, e exige parar a anterior', () => {
  const gravando = state({ phase: 'recording', mode: 'tab' });
  assert.equal(shouldIgnoreStart(gravando, 'microphone', 1_000), false);
  assert.equal(conflictingMode(gravando, 'microphone'), 'tab', 'precisa parar a aba antes');
  assert.equal(conflictingMode(gravando, 'tab'), null, 'a mesma fonte nao conflita');
  assert.equal(conflictingMode(state(), 'tab'), null, 'nada rodando, nada a parar');
});

test('parar funciona no meio da inicializacao', () => {
  assert.equal(shouldIgnoreStop(state({ phase: 'starting', mode: 'tab' }), 1_000), false);
  assert.equal(shouldIgnoreStop(state({ phase: 'loading-model', mode: 'tab' }), 1_000), false);
  assert.equal(shouldIgnoreStop(state({ phase: 'recording', mode: 'tab' }), 1_000), false);
});

test('parar duas vezes nao repete o encerramento', () => {
  assert.equal(shouldIgnoreStop(state({ phase: 'stopping' }), 1_000), true);
  assert.equal(shouldIgnoreStop(state({ phase: 'inactive' }), 1_000), true);
});

// Sem isto o botao ficaria vermelho para sempre quando o service worker
// fosse encerrado no meio de uma inicializacao.
test('watchdog considera travada a transicao sem confirmacao', () => {
  const subindo = state({ phase: 'starting', mode: 'tab', updatedAt: 1_000 });
  assert.equal(isStale(subindo, 1_000 + STALE_TRANSITION_MS - 1), false);
  assert.equal(isStale(subindo, 1_000 + STALE_TRANSITION_MS), true);
  assert.equal(reconcile(subindo, 1_000 + STALE_TRANSITION_MS).phase, 'inactive');
});

test('watchdog nao interfere em captura estavel', () => {
  const gravando = state({ phase: 'recording', mode: 'tab', updatedAt: 1_000 });
  assert.equal(isStale(gravando, 5_000_000), false, 'gravar ha muito tempo nao e travamento');
  assert.equal(reconcile(gravando, 5_000_000), gravando);
});

test('transicao travada libera um novo inicio', () => {
  const travado = state({ phase: 'starting', mode: 'tab', updatedAt: 1_000 });
  assert.equal(shouldIgnoreStart(travado, 'tab', 1_000 + STALE_TRANSITION_MS), false);
});

test('confirmacao atrasada de sessao encerrada e recusada', () => {
  const atual = state({ phase: 'starting', mode: 'tab', sessionId: 'nova' });
  assert.equal(acceptsUpdate(atual, 'nova'), true);
  assert.equal(acceptsUpdate(atual, 'antiga'), false, 'nao pode ressuscitar a interface');
  assert.equal(acceptsUpdate(atual, undefined), true, 'evento sem sessao vale sempre');
});

test('captura de aba so pinta o botao da aba dona', () => {
  const naAba7 = state({ phase: 'recording', mode: 'tab', tabId: 7 });
  assert.equal(isActiveFor(naAba7, 'tab', 7), true);
  assert.equal(isActiveFor(naAba7, 'tab', 9), false, 'outra aba fica livre');
  assert.equal(isActiveFor(naAba7, 'microphone', 7), false, 'a outra fonte nao e afetada');
});

test('microfone e global, vale para qualquer aba', () => {
  const microfone = state({ phase: 'recording', mode: 'microphone' });
  assert.equal(isActiveFor(microfone, 'microphone', 7), true);
  assert.equal(isActiveFor(microfone, 'microphone', 9), true);
});

test('estado parado ou em erro nunca aparece como ativo', () => {
  assert.equal(isActiveFor(state({ phase: 'inactive' }), 'tab', 7), false);
  assert.equal(isActiveFor(state({ phase: 'error', mode: 'tab', tabId: 7 }), 'tab', 7), false);
});
