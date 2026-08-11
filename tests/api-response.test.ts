import assert from 'node:assert/strict';
import test from 'node:test';
import { getTaskId } from '../extension/src/shared/api-response.ts';

test('extrai identificadores dos formatos suportados', () => {
  assert.equal(getTaskId({ task_id: 'task-123' }), 'task-123');
  assert.equal(getTaskId({ data: { taskId: 'nested_456' } }), 'nested_456');
  assert.equal(getTaskId('{"job_id":"job:789"}'), 'job:789');
  assert.equal(getTaskId(123), '123');
});

test('não interpreta status ou mensagens como identificadores', () => {
  assert.equal(getTaskId('accepted'), undefined);
  assert.equal(getTaskId({ status: 'pending' }), undefined);
  assert.equal(getTaskId('task created successfully'), undefined);
});
