export type PhraseSource = 'welcome' | 'selection' | 'microphone' | 'tab-audio' | 'manual';

export type ConversationMessageStatus =
  | 'capturing' | 'transcribing' | 'ready' | 'submitting' | 'queued'
  | 'generating-video' | 'completed' | 'failed' | 'cancelled';

export type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  source: PhraseSource;
  text: string;
  status: ConversationMessageStatus;
  fileUrl?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  sequence?: number;
};

export type ConversationState = { id: string; messages: ConversationMessage[]; updatedAt: number };

export type AssistantUiState = {
  minimized: boolean;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  unreadCount: number;
  draft: string;
  activeConversationId: string;
};

export type ExtensionPreferences = {
  proxyUrl: string;
  autoWelcomeEnabled: boolean;
  captionsEnabled: boolean;
  avatarExpanded: boolean;
  developerMode: boolean;
  selectionModeEnabled: boolean;
  autoSubmitSelection: boolean;
};

export type DeveloperError = { message: string; detail?: string; createdAt: number };

export type CaptionState = {
  caption: string;
  status: string;
  fileUrl?: string;
  error?: string;
  updatedAt: number;
};

export type NeoTalkApiResponse = {
  file_url?: string;
  fileUrl?: string;
  url?: string;
  video_url?: string;
  status_url?: string;
  statusUrl?: string;
  polling_url?: string;
  id?: string;
  job_id?: string;
  task_id?: string;
  taskId?: string;
  status?: string;
  result?: NeoTalkApiResponse;
  message?: unknown;
  error?: unknown;
  state?: unknown;
};

export type SubmitPhraseMessage = {
  type: 'NEOTALK_SUBMIT_PHRASE';
  frase: string;
  source: PhraseSource;
  messageId?: string;
};

export type TabAudioMessage = { type: 'NEOTALK_START_TAB_AUDIO' } | { type: 'NEOTALK_STOP_TAB_AUDIO' };

export type OffscreenMessage =
  | { type: 'NEOTALK_OFFSCREEN_START'; streamId: string }
  | { type: 'NEOTALK_OFFSCREEN_STOP' };

export type RuntimeMessage = SubmitPhraseMessage | TabAudioMessage | OffscreenMessage
  | { type: 'NEOTALK_TAB_AUDIO_TRANSCRIPT'; frase: string; sessionId: string; sequence: number; mode: 'microphone' | 'tab-audio' }
  | { type: 'NEOTALK_CLEAR_CONVERSATION' };
