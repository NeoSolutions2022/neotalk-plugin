import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechSegmenter, rootMeanSquare } from '../extension/src/offscreen/speech-segmenter.ts';

const VOICE = 0.2;
const SILENCE = 0;
const STEP = 50;

function build(options = {}) {
  const ends: boolean[] = [];
  const segmenter = new SpeechSegmenter((hadSpeech) => ends.push(hadSpeech), options);
  let now = 0;
  const feed = (level: number, durationMs: number) => {
    for (let elapsed = 0; elapsed < durationMs; elapsed += STEP) {
      now += STEP;
      segmenter.push(level, now);
    }
  };
  return { segmenter, ends, feed, at: () => now };
}

test('mede a energia do bloco', () => {
  assert.equal(rootMeanSquare(new Float32Array(0)), 0);
  assert.equal(rootMeanSquare(new Float32Array(8).fill(0)), 0);
  assert.ok(Math.abs(rootMeanSquare(new Float32Array(8).fill(0.5)) - 0.5) < 1e-6);
});

test('fecha o trecho na pausa da fala, nao num tempo fixo', () => {
  const { ends, feed } = build({ silenceMs: 700 });
  feed(VOICE, 1_000);
  assert.deepEqual(ends, [], 'ainda falando');
  feed(SILENCE, 400);
  assert.deepEqual(ends, [], 'pausa curta nao fecha');
  feed(SILENCE, 400);
  assert.deepEqual(ends, [true], 'a pausa completou o limite e o trecho tinha fala');
});

// Sem isto, blocos de puro silencio chegam ao Whisper e viram alucinacao.
test('silencio prolongado recicla a gravacao sem transcrever', () => {
  const { ends, feed } = build({ idleFlushMs: 5_000 });
  feed(SILENCE, 4_000);
  assert.deepEqual(ends, [], 'ainda dentro da janela ociosa');
  feed(SILENCE, 1_500);
  assert.deepEqual(ends, [false], 'fechou marcado para descarte');
});

test('ruido curto demais nao vira trecho transcrito', () => {
  const { ends, feed } = build({ silenceMs: 400, minSpeechMs: 500 });
  feed(VOICE, 200);
  feed(SILENCE, 500);
  assert.deepEqual(ends, [false], 'um estalo nao e fala');
});

test('quem fala sem pausa ainda e cortado, para nao gerar bloco infinito', () => {
  const { ends, feed } = build({ maxSegmentMs: 3_000 });
  feed(VOICE, 3_500);
  assert.equal(ends.length, 1);
  assert.equal(ends[0], true);
});

// O padrao era 20s: falando corrido, o texto so aparecia na tela depois de
// vinte segundos, porque o modelo so recebe o audio quando o trecho fecha.
test('o corte forcado padrao entrega texto em poucos segundos', () => {
  const { ends, feed } = build();
  feed(VOICE, 4_500);
  assert.deepEqual(ends, [], 'ainda dentro do limite padrao');
  feed(VOICE, 1_000);
  assert.deepEqual(ends, [true], 'fechou por volta dos 5s, sem esperar pausa');
});

test('falas separadas por pausa viram trechos separados', () => {
  const { ends, feed } = build({ silenceMs: 400, minSpeechMs: 200 });
  feed(VOICE, 600);
  feed(SILENCE, 500);
  feed(VOICE, 600);
  feed(SILENCE, 500);
  assert.deepEqual(ends, [true, true]);
});

test('a contagem de fala reinicia a cada trecho', () => {
  const { ends, feed } = build({ silenceMs: 400, minSpeechMs: 500 });
  feed(VOICE, 800);
  feed(SILENCE, 500);
  assert.deepEqual(ends, [true]);
  // O segundo trecho tem fala curta: nao pode herdar o credito do primeiro.
  feed(VOICE, 200);
  feed(SILENCE, 500);
  assert.deepEqual(ends, [true, false]);
});

test('end fecha na hora, para o botao parar entregar o que ja foi falado', () => {
  const { segmenter, ends, feed, at } = build();
  feed(VOICE, 800);
  segmenter.end(at());
  assert.deepEqual(ends, [true]);
});

test('speaking indica se ha fala em andamento', () => {
  const { segmenter, feed } = build({ silenceMs: 10_000 });
  assert.equal(segmenter.speaking, false);
  feed(VOICE, 200);
  assert.equal(segmenter.speaking, true);
});
