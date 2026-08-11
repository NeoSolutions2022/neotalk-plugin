import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTranscript } from '../extension/src/shared/transcript.ts';

test('normaliza espaços, controles e pontuação', () => {
  assert.equal(normalizeTranscript('  Olá\u0000   mundo  !  '), 'Olá mundo!');
});

test('rejeita silêncio, pontuação e texto vazio', () => {
  assert.equal(normalizeTranscript('[silêncio]'), '');
  assert.equal(normalizeTranscript('... !'), '');
  assert.equal(normalizeTranscript('   '), '');
});

test('remove somente uma sobreposição relevante entre blocos', () => {
  assert.equal(normalizeTranscript('de hoje vamos continuar', 'Na reunião de hoje'), 'vamos continuar');
  assert.equal(normalizeTranscript('muito muito obrigado', 'Anterior'), 'muito muito obrigado');
});
