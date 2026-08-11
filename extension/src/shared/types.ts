export type PhraseSource = 'welcome' | 'selection' | 'microphone' | 'tab-audio' | 'manual';

export type ExtensionPreferences = {
  proxyUrl: string;
  autoWelcomeEnabled: boolean;
  captionsEnabled: boolean;
  avatarExpanded: boolean;
  developerMode: boolean;
  apiKey: string;
  selectionModeEnabled: boolean;
  autoSubmitSelection: boolean;
};

export type AudioCaptureMode = 'tab' | 'microphone';
export type AudioCaptureState = {
  phase: 'inactive' | 'starting' | 'loading-model' | 'recording' | 'transcribing' | 'stopping' | 'error';
  mode?: AudioCaptureMode;
  sessionId?: string;
  queueSize?: number;
  progress?: number;
  message?: string;
  updatedAt: number;
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
};

export type TabAudioMessage = { type: 'NEOTALK_START_TAB_AUDIO' } | { type: 'NEOTALK_STOP_TAB_AUDIO' };

export type MicrophoneMessage = { type: 'NEOTALK_START_MICROPHONE' } | { type: 'NEOTALK_STOP_MICROPHONE' };

export type OffscreenMessage =
  | { type: 'NEOTALK_OFFSCREEN_START'; streamId: string }
  | { type: 'NEOTALK_OFFSCREEN_STOP' }
  | { type: 'NEOTALK_OFFSCREEN_START_MIC' }
  | { type: 'NEOTALK_OFFSCREEN_STOP_MIC' };

export type CaptureResponse = { ok: boolean; error?: string };

export type RuntimeMessage = SubmitPhraseMessage | TabAudioMessage | MicrophoneMessage | OffscreenMessage
  | { type: 'NEOTALK_TAB_AUDIO_TRANSCRIPT'; frase: string; sessionId: string; sequence: number; mode: AudioCaptureMode };
