export type PhraseSource = 'welcome' | 'selection' | 'microphone' | 'tab-audio' | 'manual';

export type ExtensionPreferences = {
  proxyUrl: string;
  autoWelcomeEnabled: boolean;
  captionsEnabled: boolean;
  avatarExpanded: boolean;
  developerMode: boolean;
  apiKey: string;
  selectionModeEnabled: boolean;
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
};

export type SubmitPhraseMessage = {
  type: 'NEOTALK_SUBMIT_PHRASE';
  frase: string;
  source: PhraseSource;
};

export type TabAudioMessage = { type: 'NEOTALK_START_TAB_AUDIO' } | { type: 'NEOTALK_STOP_TAB_AUDIO' };

export type OffscreenMessage =
  | { type: 'NEOTALK_OFFSCREEN_START'; streamId: string }
  | { type: 'NEOTALK_OFFSCREEN_STOP' };

export type RuntimeMessage = SubmitPhraseMessage | TabAudioMessage | OffscreenMessage | { type: 'NEOTALK_TAB_AUDIO_TRANSCRIPT'; frase: string };
