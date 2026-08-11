import type { NeoTalkApiResponse } from './types.js';

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/;
const NON_TASK_VALUES = new Set(['accepted', 'pending', 'queued', 'started', 'processing', 'running', 'in_progress', 'ok', 'success']);

export function parseMaybeJson(text: string): NeoTalkApiResponse | string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed) as NeoTalkApiResponse;
  } catch {
    return trimmed;
  }
}

export function getTaskId(response: unknown): string | undefined {
  if (response == null) return undefined;
  if (typeof response === 'number') return String(response);
  if (typeof response === 'string') {
    const parsed = parseMaybeJson(response);
    if (parsed !== response) return getTaskId(parsed);
    const candidate = response.trim();
    return TASK_ID_PATTERN.test(candidate) && !NON_TASK_VALUES.has(candidate.toLowerCase()) ? candidate : undefined;
  }
  if (typeof response !== 'object') return undefined;

  const payload = response as Record<string, unknown>;
  const directTaskId = payload.task_id ?? payload.taskId ?? payload.taskID ?? payload.id ?? payload.job_id ?? payload.jobId ?? payload.celery_task_id ?? payload.task;
  if (typeof directTaskId === 'string') {
    const candidate = directTaskId.trim();
    if (TASK_ID_PATTERN.test(candidate) && !NON_TASK_VALUES.has(candidate.toLowerCase())) return candidate;
  }
  if (typeof directTaskId === 'number') return String(directTaskId);

  for (const nestedKey of ['data', 'result', 'task', 'payload']) {
    const nestedTaskId = getTaskId(payload[nestedKey]);
    if (nestedTaskId) return nestedTaskId;
  }
  return undefined;
}
