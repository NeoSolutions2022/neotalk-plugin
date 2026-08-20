import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION_HOST_ID, blobToBase64, isEligibleMediaElement, pickLiveAudioTracks } from '../extension/src/content/page-audio-utils.ts';
import type { MediaCandidate } from '../extension/src/content/page-audio-utils.ts';

const playing = (overrides: Partial<MediaCandidate> = {}): MediaCandidate => ({
  paused: false, ended: false, muted: false, volume: 1, captureStream: () => ({} as MediaStream), ...overrides
});

test('elemento tocando, audível e com captureStream é elegível', () => {
  assert.equal(isEligibleMediaElement(playing()), true);
});

test('elemento pausado não é elegível', () => {
  assert.equal(isEligibleMediaElement(playing({ paused: true })), false);
});

test('elemento que já terminou não é elegível', () => {
  assert.equal(isEligibleMediaElement(playing({ ended: true })), false);
});

test('elemento mudo não é elegível', () => {
  assert.equal(isEligibleMediaElement(playing({ muted: true })), false);
});

test('elemento com volume zero não é elegível', () => {
  assert.equal(isEligibleMediaElement(playing({ volume: 0 })), false);
});

// Alguns elementos (ou navegadores) não suportam captureStream — sem isso a
// captura falharia silenciosamente mais adiante, então é melhor descartar aqui.
test('elemento sem suporte a captureStream não é elegível', () => {
  assert.equal(isEligibleMediaElement(playing({ captureStream: undefined })), false);
});

test('converte um blob para base64 e volta ao conteúdo original', async () => {
  const original = 'áudio de teste, com acento e vírgula';
  const blob = new Blob([original], { type: 'text/plain' });
  const base64 = await blobToBase64(blob);

  assert.equal(typeof base64, 'string');
  assert.ok(base64.length > 0);
  assert.equal(Buffer.from(base64, 'base64').toString('utf-8'), original);
});

test('lida com um blob maior que um único bloco de conversão', async () => {
  // A conversão processa em blocos de 32KB; um blob maior exercita mais de um bloco.
  const bytes = new Uint8Array(100_000).map((_, index) => index % 256);
  const blob = new Blob([bytes]);
  const base64 = await blobToBase64(blob);

  const decoded = Buffer.from(base64, 'base64');
  assert.equal(decoded.length, bytes.length);
  assert.deepEqual(new Uint8Array(decoded), bytes);
});

test('o avatar da própria extensão nunca é escolhido como fonte', () => {
  const avatar = playing({ getRootNode: () => ({ host: { id: EXTENSION_HOST_ID } }) });
  assert.equal(isEligibleMediaElement(avatar), false);
});

test('mídia dentro de outro shadow root da página continua elegível', () => {
  const inWebComponent = playing({ getRootNode: () => ({ host: { id: 'player-de-algum-site' } }) });
  assert.equal(isEligibleMediaElement(inWebComponent), true);
});

test('só as faixas vivas são aproveitadas', () => {
  const tracks = [{ readyState: 'live' }, { readyState: 'ended' }, { readyState: 'live' }];
  assert.deepEqual(pickLiveAudioTracks(tracks), [{ readyState: 'live' }, { readyState: 'live' }]);
});

test('faixas de uma captura anterior, todas encerradas, não valem nada', () => {
  assert.deepEqual(pickLiveAudioTracks([{ readyState: 'ended' }, { readyState: 'ended' }]), []);
});

test('lista vazia devolve lista vazia', () => {
  assert.deepEqual(pickLiveAudioTracks([]), []);
});
