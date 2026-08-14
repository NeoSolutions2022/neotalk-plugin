import test from 'node:test';
import assert from 'node:assert/strict';
import { numberToWords, sanitizePhrase } from '../extension/src/shared/text.ts';

test('remove emoji sem comer o texto ao redor', () => {
  assert.equal(sanitizePhrase('Bom dia \u{1F600} pessoal'), 'Bom dia pessoal');
  assert.equal(sanitizePhrase('Vamos \u{1F1E7}\u{1F1F7} juntos'), 'Vamos juntos');
  assert.equal(sanitizePhrase('familia \u{1F468}\u200D\u{1F469}\u200D\u{1F467} reunida'), 'familia reunida');
});

test('remove caracteres invisiveis que vem da selecao de paginas', () => {
  assert.equal(sanitizePhrase('Bom\u200Bdia\u200B'), 'Bomdia');
  assert.equal(sanitizePhrase('\uFEFFOla mundo'), 'Ola mundo');
  assert.equal(sanitizePhrase('quebra de\u000Blinha'), 'quebra de linha');
  assert.equal(sanitizePhrase('texto\u0000nulo'), 'texto nulo');
});

test('normaliza pontuacao tipografica para ASCII', () => {
  assert.equal(sanitizePhrase('“bom dia”'), '"bom dia"');
  assert.equal(sanitizePhrase('nao — pare'), 'nao - pare');
  assert.equal(sanitizePhrase('espere…'), 'espere...');
  assert.equal(sanitizePhrase('dois\u00A0espacos'), 'dois espacos');
});

test('remove URLs e e-mails, que nao tem glosa em Libras', () => {
  assert.equal(sanitizePhrase('acesse https://neotalk.com.br agora'), 'acesse agora');
  assert.equal(sanitizePhrase('escreva para contato@neotalk.com.br hoje'), 'escreva para hoje');
  assert.equal(sanitizePhrase('veja www.exemplo.com ok'), 'veja ok');
});

test('preserva acentuacao e cedilha', () => {
  assert.equal(sanitizePhrase('ação coração ãéíõû'), 'ação coração ãéíõû');
  assert.equal(sanitizePhrase('a\u0301gua'), 'água', 'NFD deve virar NFC');
});

test('colapsa espacos e recorta no limite sem cortar palavra ao meio', () => {
  assert.equal(sanitizePhrase('  muitos     espacos   '), 'muitos espacos');
  assert.equal(sanitizePhrase('abcde fghij klmno', { maxChars: 12 }), 'abcde fghij');
});

test('devolve vazio quando nao sobra nada traduzivel', () => {
  assert.equal(sanitizePhrase('\u{1F600}\u{1F600}'), '');
  assert.equal(sanitizePhrase('...!!!'), '');
  assert.equal(sanitizePhrase('   '), '');
  assert.equal(sanitizePhrase(''), '');
});

test('pontuacao so e removida quando pedido', () => {
  assert.equal(sanitizePhrase('Bom dia, tudo bem?'), 'Bom dia, tudo bem?');
  assert.equal(sanitizePhrase('Bom dia, tudo bem?', { stripPunctuation: true }), 'Bom dia tudo bem');
});

test('numeros por extenso ficam desligados por padrao', () => {
  assert.equal(sanitizePhrase('tenho 42 anos'), 'tenho 42 anos');
  assert.equal(sanitizePhrase('tenho 42 anos', { expandNumbers: true }), 'tenho quarenta e dois anos');
  assert.equal(sanitizePhrase('subiu 50%', { expandNumbers: true }), 'subiu cinquenta por cento');
  assert.equal(sanitizePhrase('custa 1,5', { expandNumbers: true }), 'custa um vírgula cinco');
});

test('escreve numeros por extenso em portugues', () => {
  assert.equal(numberToWords(0), 'zero');
  assert.equal(numberToWords(15), 'quinze');
  assert.equal(numberToWords(42), 'quarenta e dois');
  assert.equal(numberToWords(100), 'cem');
  assert.equal(numberToWords(101), 'cento e um');
  assert.equal(numberToWords(999), 'novecentos e noventa e nove');
  assert.equal(numberToWords(1000), 'mil');
  assert.equal(numberToWords(1200), 'mil e duzentos');
  assert.equal(numberToWords(2026), 'dois mil e vinte e seis');
  assert.equal(numberToWords(1_000_000), 'um milhão');
  assert.equal(numberToWords(-7), 'menos sete');
});
