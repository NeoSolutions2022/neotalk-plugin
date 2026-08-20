import test from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGES, captureErrorMessage } from '../extension/src/shared/messages.ts';
const NO_MEDIA_ELEMENT = 'no-media-element';
const MICROPHONE_PERMISSION_REQUIRED = 'microphone-permission-required';

test('sem erro, a linha de status fica vazia', () => {
  assert.equal(captureErrorMessage(undefined, 'tab'), '');
  assert.equal(captureErrorMessage('', 'microphone'), '');
});

test('códigos conhecidos viram orientação ao usuário', () => {
  assert.equal(captureErrorMessage(NO_MEDIA_ELEMENT, 'tab'), MESSAGES.noMediaElement);
  assert.equal(captureErrorMessage(MICROPHONE_PERMISSION_REQUIRED, 'microphone'), MESSAGES.microphonePermissionRequired);
});

test('mensagem técnica do navegador não chega à tela', () => {
  const domException = "Failed to execute 'start' on 'MediaRecorder': There was an error starting the MediaRecorder.";
  assert.equal(captureErrorMessage(domException, 'tab'), MESSAGES.tabAudioStartFailed);
  assert.equal(captureErrorMessage(domException, 'microphone'), MESSAGES.microphoneStartFailed);
});

test('mensagem que já é para o usuário passa intacta', () => {
  assert.equal(captureErrorMessage(MESSAGES.tabAudioUnsupported, 'tab'), MESSAGES.tabAudioUnsupported);
});
