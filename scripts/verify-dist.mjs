/**
 * Confere que o `dist/` ficou carregável pelo Chrome.
 *
 * O `tsc` emite os dois arquivos abaixo em formato ESM, e o `esbuild` os
 * sobrescreve logo depois — o content script como IIFE, o offscreen com o
 * modelo de transcrição embutido. Quando o `esbuild` não roda (compilação que
 * falha no meio da cadeia `&&`), sobram as versões do `tsc`: a extensão carrega,
 * o content script morre na primeira linha e nada funciona, sem erro óbvio.
 *
 * É a checagem manual da seção 3.5 do HANDOFF.md virando automática.
 */
import { readFileSync, statSync } from 'node:fs';

const CONTENT_SCRIPT = 'extension/dist/content/content-script.js';
const OFFSCREEN = 'extension/dist/offscreen/offscreen.js';
/** O bundle com o Whisper passa de 1 MB; a saída crua do `tsc` tem dezenas de KB. */
const OFFSCREEN_MIN_BYTES = 500_000;

const problems = [];

try {
  const head = readFileSync(CONTENT_SCRIPT, 'utf8').slice(0, 4_000);
  if (/^\s*(import|export)[\s{'"*]/m.test(head)) {
    problems.push(`${CONTENT_SCRIPT} saiu em formato ESM — o esbuild não rodou. Content script do MV3 não aceita "import".`);
  }
} catch {
  problems.push(`${CONTENT_SCRIPT} não existe.`);
}

try {
  const { size } = statSync(OFFSCREEN);
  if (size < OFFSCREEN_MIN_BYTES) {
    problems.push(`${OFFSCREEN} tem ${Math.round(size / 1024)} KB — o modelo de transcrição não foi embutido pelo esbuild.`);
  }
} catch {
  problems.push(`${OFFSCREEN} não existe.`);
}

if (problems.length > 0) {
  console.error('\nBuild inválido — o Chrome não vai carregar isto:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nRode "npm run rebuild" e confira os erros do esbuild.\n');
  process.exit(1);
}

console.log('dist ok: content script em IIFE, offscreen com o modelo embutido.');
