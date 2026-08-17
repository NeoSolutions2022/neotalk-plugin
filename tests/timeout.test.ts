import test from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from '../extension/src/shared/timeout.ts';

test('resolve com o valor quando a promise termina antes do limite', async () => {
  const resultado = await withTimeout(Promise.resolve('ok'), 50, 'estourou');
  assert.equal(resultado, 'ok');
});

test('propaga a rejeição original quando ela chega antes do limite', async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error('falhou de verdade')), 50, 'estourou'),
    /falhou de verdade/
  );
});

// É exatamente o caso que motivou este módulo: chrome.runtime.sendMessage às
// vezes nunca chama o callback quando o destino ainda não está pronto, e um
// await simples ficaria pendurado para sempre sem isto.
test('rejeita com a mensagem de timeout quando a promise nunca resolve', async () => {
  const pendurada = new Promise(() => {});
  await assert.rejects(withTimeout(pendurada, 20, 'estourou'), /estourou/);
});

test('não deixa o timer pendente disparar depois que já resolveu', async () => {
  let disparou = false;
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void, ms: number) => {
    const handle = original(() => { disparou = true; callback(); }, ms);
    return handle;
  }) as typeof setTimeout;

  try {
    await withTimeout(Promise.resolve('rápido'), 200, 'não deveria estourar');
    await new Promise((resolve) => original(resolve, 250));
    assert.equal(disparou, false, 'o timer deveria ter sido cancelado');
  } finally {
    globalThis.setTimeout = original;
  }
});
