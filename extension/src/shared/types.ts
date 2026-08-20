export type PhraseSource = 'selection' | 'microphone' | 'tab-audio' | 'manual';

export type AvatarName = 'lia' | 'asuna';

export type ExtensionPreferences = {
  proxyUrl: string;
  /** Base da plataforma Avatar3D, que hospeda o widget 3D embutido no balão. */
  avatar3dUrl: string;
  avatarName: AvatarName;
  captionsEnabled: boolean;
  avatarExpanded: boolean;
  developerMode: boolean;
  apiKey: string;
  selectionModeEnabled: boolean;
  autoSubmitSelection: boolean;
};

export type AudioCaptureMode = 'tab' | 'microphone';
export type AudioCapturePhase = 'inactive' | 'starting' | 'loading-model' | 'recording' | 'transcribing' | 'stopping' | 'error';
export type AudioCaptureState = {
  phase: AudioCapturePhase;
  mode?: AudioCaptureMode;
  sessionId?: string;
  /** Aba dona da captura, para o botão não ficar vermelho nas outras. */
  tabId?: number;
  queueSize?: number;
  progress?: number;
  message?: string;
  updatedAt: number;
};

export type DeveloperError = { message: string; detail?: string; createdAt: number };

export type CaptionState = {
  caption: string;
  /**
   * Texto ainda em reconhecimento, que muda a cada instante e será substituído
   * pela versão final. Fica separado de `caption` porque só o texto confirmado
   * pode ser acumulado e mandado para tradução — o parcial é descartável por
   * natureza, e some assim que a frase fecha.
   */
  partialCaption?: string;
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
  | { type: 'NEOTALK_OFFSCREEN_STOP_MIC' }
  | { type: 'NEOTALK_OFFSCREEN_PING' }
  | { type: 'NEOTALK_OFFSCREEN_TRANSCRIBE_CHUNK'; audioBase64: string; mimeType: string };

export type CaptureResponse = { ok: boolean; error?: string; text?: string };

/**
 * Um trecho de áudio gravado no content script.
 *
 * `partial: true` é uma prévia do trecho ainda aberto, mandada a cada ~1,2s
 * para o texto ir aparecendo enquanto o áudio toca; o mesmo trecho é reenviado
 * várias vezes, sempre maior. `partial: false` (ou ausente) é o trecho fechado
 * na pausa da fala — só esse conta como texto definitivo e vai para tradução.
 */
export type PageAudioChunkMessage = {
  type: 'NEOTALK_PAGE_AUDIO_CHUNK';
  sessionId: string;
  sequence: number;
  audioBase64: string;
  mimeType: string;
  partial?: boolean;
};

/**
 * Uma frase pronta para virar sinal no avatar 3D, mandada para o content script
 * da aba — é lá que o balão hospeda o widget. Substitui o caminho antigo, em que
 * o service worker chamava a API NeoTalk e devolvia um `fileUrl` de vídeo.
 */
export type SignPhraseMessage = { type: 'NEOTALK_SIGN_PHRASE'; frase: string };

export type RuntimeMessage = SubmitPhraseMessage | TabAudioMessage | MicrophoneMessage | OffscreenMessage | SignPhraseMessage
  | { type: 'NEOTALK_TAB_AUDIO_TRANSCRIPT'; frase: string; sessionId: string; sequence: number; mode: AudioCaptureMode; partial?: boolean }
  | { type: 'NEOTALK_WHICH_TAB' }
  | PageAudioChunkMessage;
