import type { ConversationMessage, ConversationMessageStatus, ConversationState } from './types.js';

export const CONVERSATION_LIMIT = 30;
const transitions: Record<ConversationMessageStatus, ConversationMessageStatus[]> = {
  capturing: ['transcribing', 'cancelled', 'failed'], transcribing: ['ready', 'submitting', 'cancelled', 'failed'],
  ready: ['submitting', 'cancelled'], submitting: ['queued', 'generating-video', 'completed', 'failed', 'cancelled'],
  queued: ['generating-video', 'completed', 'failed', 'cancelled'], 'generating-video': ['completed', 'failed', 'cancelled'],
  completed: ['submitting'], failed: ['submitting', 'cancelled'], cancelled: ['submitting']
};

export function canTransition(from: ConversationMessageStatus, to: ConversationMessageStatus): boolean {
  return from === to || transitions[from].includes(to);
}

export function appendMessage(state: ConversationState, message: ConversationMessage): ConversationState {
  return { ...state, messages: [...state.messages.filter(({ id }) => id !== message.id), message].slice(-CONVERSATION_LIMIT), updatedAt: message.updatedAt };
}

export function updateMessage(state: ConversationState, id: string, patch: Partial<ConversationMessage>): ConversationState {
  const current = state.messages.find((message) => message.id === id);
  if (!current || (patch.status && !canTransition(current.status, patch.status))) return state;
  const updatedAt = patch.updatedAt ?? Date.now();
  return { ...state, messages: state.messages.map((message) => message.id === id ? { ...message, ...patch, id, updatedAt } : message), updatedAt };
}
