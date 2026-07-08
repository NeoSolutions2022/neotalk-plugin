import type { CaptionState, ExtensionPreferences } from './types.js';

export const DEFAULT_PROXY_URL = 'https://api.neotalk.com/extension/sign-process-pose';
export const DEFAULT_PREFERENCES: ExtensionPreferences = {
  proxyUrl: DEFAULT_PROXY_URL,
  autoWelcomeEnabled: true,
  captionsEnabled: true,
  avatarExpanded: true
};

const PREFERENCES_KEY = 'neotalkPreferences';
const CAPTION_STATE_KEY = 'neotalkCaptionState';
const WELCOME_SENT_KEY = 'neotalkWelcomeSent';

export async function getPreferences(): Promise<ExtensionPreferences> {
  const result = await chrome.storage.sync.get(PREFERENCES_KEY);
  return { ...DEFAULT_PREFERENCES, ...(result[PREFERENCES_KEY] as Partial<ExtensionPreferences> | undefined) };
}

export async function savePreferences(preferences: ExtensionPreferences): Promise<void> {
  await chrome.storage.sync.set({ [PREFERENCES_KEY]: preferences });
}

export async function getCaptionState(): Promise<CaptionState> {
  const result = await chrome.storage.local.get(CAPTION_STATE_KEY);
  return (result[CAPTION_STATE_KEY] as CaptionState | undefined) ?? { caption: '', status: '', updatedAt: Date.now() };
}

export async function saveCaptionState(state: Partial<CaptionState>): Promise<void> {
  const current = await getCaptionState();
  await chrome.storage.local.set({ [CAPTION_STATE_KEY]: { ...current, ...state, updatedAt: Date.now() } });
}

export async function wasWelcomeSent(): Promise<boolean> {
  if (chrome.storage.session) {
    const result = await chrome.storage.session.get(WELCOME_SENT_KEY);
    return Boolean(result[WELCOME_SENT_KEY]);
  }
  const result = await chrome.storage.local.get(WELCOME_SENT_KEY);
  return Boolean(result[WELCOME_SENT_KEY]);
}

export async function markWelcomeSent(): Promise<void> {
  if (chrome.storage.session) {
    await chrome.storage.session.set({ [WELCOME_SENT_KEY]: true });
    return;
  }
  await chrome.storage.local.set({ [WELCOME_SENT_KEY]: true });
}

export { CAPTION_STATE_KEY };
