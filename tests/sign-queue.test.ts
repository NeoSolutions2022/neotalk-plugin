import assert from 'node:assert/strict';
import test from 'node:test';
import { fallbackDuration, MAX_QUEUED_PHRASES, SignQueue } from '../extension/src/content/sign-queue.ts';

/** Relógio de mentira: nada de espera real, e cada agendamento é visível. */
function createHarness(duration: number | null = 1_000) {
  const sent: string[] = [];
  let pendingRun: (() => void) | null = null;
  const resolvers: (() => void)[] = [];

  const queue = new SignQueue({
    send: (phrase) => sent.push(phrase),
    schedule: (run) => {
      pendingRun = run;
      return () => { pendingRun = null; };
    },
    resolveDuration: () => new Promise((resolve) => {
      resolvers.push(() => resolve(duration));
    })
  });

  return {
    queue,
    sent,
    /** Simula o widget: começou a tocar, a duração chegou, o tempo passou. */
    async finishPlayback(): Promise<void> {
      queue.onPlaying('task-1', 2);
      const resolve = resolvers.shift();
      if (resolve) resolve();
      await Promise.resolve();
      await Promise.resolve();
      pendingRun?.();
    }
  };
}

test('nada é enviado antes do avatar ficar pronto', () => {
  const { queue, sent } = createHarness();
  queue.enqueue('primeira');
  assert.deepEqual(sent, []);
  queue.onReady();
  assert.deepEqual(sent, ['primeira']);
});

test('um sinal por vez, na ordem em que as frases chegaram', async () => {
  const harness = createHarness();
  harness.queue.onReady();
  harness.queue.enqueue('uma');
  harness.queue.enqueue('duas');
  harness.queue.enqueue('tres');

  // Sem o fim da reprodução, a segunda não pode ter saído.
  assert.deepEqual(harness.sent, ['uma']);

  await harness.finishPlayback();
  assert.deepEqual(harness.sent, ['uma', 'duas']);

  await harness.finishPlayback();
  assert.deepEqual(harness.sent, ['uma', 'duas', 'tres']);
});

test('falha na frase em curso não trava as seguintes', () => {
  const harness = createHarness();
  harness.queue.onReady();
  harness.queue.enqueue('quebra');
  harness.queue.enqueue('segue');
  assert.deepEqual(harness.sent, ['quebra']);

  harness.queue.onError();
  assert.deepEqual(harness.sent, ['quebra', 'segue']);
});

test('sem a duração real, o palpite ainda destrava a fila', async () => {
  const harness = createHarness(null);
  harness.queue.onReady();
  harness.queue.enqueue('uma');
  harness.queue.enqueue('duas');

  await harness.finishPlayback();
  assert.deepEqual(harness.sent, ['uma', 'duas']);
});

test('fila cheia descarta as mais antigas, não as recentes', () => {
  const harness = createHarness();
  harness.queue.onReady();
  const total = MAX_QUEUED_PHRASES + 3;
  for (let index = 0; index < total; index += 1) {
    harness.queue.enqueue(`frase ${index}`);
  }
  // A primeira sai na hora e não ocupa fila: das 13 sobram 12 esperando, e o
  // teto de 10 corta 2.
  assert.deepEqual(harness.sent, ['frase 0']);
  assert.equal(harness.queue.size, MAX_QUEUED_PHRASES);
  assert.equal(harness.queue.dropped, total - 1 - MAX_QUEUED_PHRASES);
});

test('frase vazia ou só espaço é ignorada', () => {
  const { queue, sent } = createHarness();
  queue.onReady();
  queue.enqueue('   ');
  queue.enqueue('');
  assert.deepEqual(sent, []);
});

test('reset esquece o que estava pendente', () => {
  const harness = createHarness();
  harness.queue.onReady();
  harness.queue.enqueue('uma');
  harness.queue.enqueue('duas');
  harness.queue.reset();
  assert.equal(harness.queue.size, 0);
  // Depois do reset a fila volta a esperar o avatar ficar pronto.
  harness.queue.enqueue('tres');
  assert.deepEqual(harness.sent, ['uma']);
});

test('o palpite de duração respeita o piso e o teto', () => {
  assert.equal(fallbackDuration(0), 1_500);
  assert.equal(fallbackDuration(1), 1_500);
  assert.equal(fallbackDuration(5), 6_000);
  assert.equal(fallbackDuration(1_000), 12_000);
});
