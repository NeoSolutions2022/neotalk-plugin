import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBaseUrl } from '../extension/src/shared/api-url.ts';

test('normaliza a URL base e remove endpoints conhecidos', () => {
  assert.equal(normalizeBaseUrl('https://example.com/sign-process-video?debug=1#x'), 'https://example.com');
  assert.equal(normalizeBaseUrl('https://example.com/api/'), 'https://example.com/api');
});

test('rejeita protocolos inseguros, exceto localhost em desenvolvimento', () => {
  assert.throws(() => normalizeBaseUrl('http://example.com'));
  assert.throws(() => normalizeBaseUrl('https://user:secret@example.com'));
  assert.equal(normalizeBaseUrl('http://localhost:3000/', true), 'http://localhost:3000');
});
