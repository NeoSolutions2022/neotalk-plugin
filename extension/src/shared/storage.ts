import type { CaptionState, DeveloperError, ExtensionPreferences } from './types.js';

export const DEFAULT_PROXY_URL = 'https://api.neotalk.com/extension';
export const DEFAULT_PREFERENCES: ExtensionPreferences = {
  proxyUrl: DEFAULT_PROXY_URL,
  autoWelcomeEnabled: true,
  captionsEnabled: true,
  avatarExpanded: true,
  developerMode: false,
  apiKey: '',
  selectionModeEnabled: false
};

const PREFERENCES_KEY = 'neotalkPreferences';
const CAPTION_STATE_KEY = 'neotalkCaptionState';
const WELCOME_SENT_KEY = 'neotalkWelcomeSent';
const SELECTED_TEXT_KEY = 'neotalkSelectedText';
const DEVELOPER_ERRORS_KEY = 'neotalkDeveloperErrors';

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

export async function saveSelectedText(frase: string): Promise<void> {
  await chrome.storage.local.set({ [SELECTED_TEXT_KEY]: frase });
}

export async function getSelectedText(): Promise<string> {
  const result = await chrome.storage.local.get(SELECTED_TEXT_KEY);
  return typeof result[SELECTED_TEXT_KEY] === 'string' ? result[SELECTED_TEXT_KEY] : '';
}

export async function addDeveloperError(message: string, detail?: unknown): Promise<void> {
  const result = await chrome.storage.local.get(DEVELOPER_ERRORS_KEY);
  const errors = (result[DEVELOPER_ERRORS_KEY] as DeveloperError[] | undefined) ?? [];
  const normalizedDetail = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : undefined;
  await chrome.storage.local.set({
    [DEVELOPER_ERRORS_KEY]: [{ message, detail: normalizedDetail, createdAt: Date.now() }, ...errors].slice(0, 20)
  });
}

export async function getDeveloperErrors(): Promise<DeveloperError[]> {
  const result = await chrome.storage.local.get(DEVELOPER_ERRORS_KEY);
  return (result[DEVELOPER_ERRORS_KEY] as DeveloperError[] | undefined) ?? [];
}

export async function clearDeveloperErrors(): Promise<void> {
  await chrome.storage.local.set({ [DEVELOPER_ERRORS_KEY]: [] });
}

export { CAPTION_STATE_KEY, DEVELOPER_ERRORS_KEY, SELECTED_TEXT_KEY };

