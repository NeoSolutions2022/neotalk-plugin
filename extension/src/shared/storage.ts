import type { AudioCaptureState, CaptionState, DeveloperError, ExtensionPreferences } from './types.js';

export const DEFAULT_PROXY_URL = 'https://infra-neotalk-api.k3p3ex.easypanel.host';
export const DEFAULT_PREFERENCES: ExtensionPreferences = {
  proxyUrl: DEFAULT_PROXY_URL,
  captionsEnabled: true,
  avatarExpanded: true,
  developerMode: false,
  apiKey: '',
  selectionModeEnabled: true,
  autoSubmitSelection: false
};

const PREFERENCES_KEY = 'neotalkPreferences';
const CAPTION_STATE_KEY = 'neotalkCaptionState';
const SELECTED_TEXT_KEY = 'neotalkSelectedText';
const DEVELOPER_ERRORS_KEY = 'neotalkDeveloperErrors';
const API_KEY_KEY = 'neotalkDeveloperApiKey';
const AUDIO_CAPTURE_STATE_KEY = 'neotalkAudioCaptureState';
const TRANSCRIPT_KEY = 'neotalkSessionTranscript';

/**
 * `chrome.storage` nem sempre existe no momento da chamada: um documento
 * offscreen recém-criado ainda não terminou de expor a API, e um content
 * script fica órfão quando a extensão é recarregada com a aba aberta — ali o
 * objeto `chrome` sobrevive mas `chrome.storage` some.
 *
 * Antes, qualquer chamada nessa janela lançava "Cannot read properties of
 * undefined (reading 'local')". O caso mais nocivo era `addDeveloperError`,
 * que é o próprio tratador de erro: ele estourava POR CIMA da falha original,
 * que se perdia sem nunca chegar ao log — o console mostrava o TypeError e
 * jamais a causa real.
 *
 * Agora a indisponibilidade vira aviso no console e a operação é ignorada.
 * Perder uma gravação de estado é recuperável; perder o diagnóstico não é.
 */
function storageArea(area: 'local' | 'sync'): chrome.storage.StorageArea | null {
  return (globalThis as { chrome?: typeof chrome }).chrome?.storage?.[area] ?? null;
}

async function readArea(area: 'local' | 'sync', key: string): Promise<Record<string, unknown>> {
  const storage = storageArea(area);
  if (!storage) {
    console.warn(`NeoTalk: chrome.storage.${area} indisponível ao ler "${key}" — contexto encerrado ou ainda iniciando.`);
    return {};
  }
  return storage.get(key);
}

async function writeArea(area: 'local' | 'sync', values: Record<string, unknown>): Promise<void> {
  const storage = storageArea(area);
  if (!storage) {
    console.warn(`NeoTalk: chrome.storage.${area} indisponível ao gravar "${Object.keys(values).join(', ')}" — contexto encerrado ou ainda iniciando.`);
    return;
  }
  await storage.set(values);
}

export async function getPreferences(): Promise<ExtensionPreferences> {
  const result = await readArea('sync', PREFERENCES_KEY);
  const stored = result[PREFERENCES_KEY] as Partial<ExtensionPreferences> | undefined;
  const secret = await readArea('local', API_KEY_KEY);
  return { ...DEFAULT_PREFERENCES, ...stored, apiKey: typeof secret[API_KEY_KEY] === 'string' ? secret[API_KEY_KEY] : '' };
}

export async function savePreferences(preferences: ExtensionPreferences): Promise<void> {
  const { apiKey, ...syncPreferences } = preferences;
  await Promise.all([
    writeArea('sync', { [PREFERENCES_KEY]: syncPreferences }),
    writeArea('local', { [API_KEY_KEY]: apiKey })
  ]);
}

export async function migrateStoredApiKey(): Promise<void> {
  const result = await readArea('sync', PREFERENCES_KEY);
  const stored = result[PREFERENCES_KEY] as Partial<ExtensionPreferences> | undefined;
  if (!stored || typeof stored.apiKey !== 'string') return;
  await writeArea('local', { [API_KEY_KEY]: stored.apiKey });
  const { apiKey: _removed, ...safePreferences } = stored;
  void _removed;
  await writeArea('sync', { [PREFERENCES_KEY]: safePreferences });
}

export async function getAudioCaptureState(): Promise<AudioCaptureState> {
  const result = await readArea('local', AUDIO_CAPTURE_STATE_KEY);
  return (result[AUDIO_CAPTURE_STATE_KEY] as AudioCaptureState | undefined) ?? { phase: 'inactive', updatedAt: Date.now() };
}

/**
 * Mesma proteção que `captionWriteChain` dá à legenda, e pelo mesmo motivo — que
 * aqui custou mais caro. `saveAudioCaptureState` lê o estado atual antes de
 * escrever (para preservar o `tabId`), e esse ler-modificar-escrever não é
 * atômico: duas chamadas sobrepostas podem ambas ler antes de qualquer uma
 * gravar, e a última apaga a outra.
 *
 * A partida do microfone faz três gravações em sequência curta
 * (`inactive` → `starting` → `recording`) enquanto o service worker grava a
 * sua própria `starting`. Perder a de `recording` deixa a fase presa em
 * `starting`: o botão fica em "Preparando..." para sempre, desabilitado, com a
 * captura rodando por baixo e sem nenhum jeito de parar a não ser fechar a aba.
 */
let captureWriteChain: Promise<void> = Promise.resolve();

export function saveAudioCaptureState(state: Omit<AudioCaptureState, 'updatedAt'>): Promise<void> {
  const next = captureWriteChain.then(async () => {
    // A aba dona da captura é definida pelo service worker, mas o documento
    // offscreen também grava estado durante a sessão. Sem preservar o tabId, o
    // botão deixaria de aparecer como ativo na aba certa no meio da gravação.
    const previous = state.phase === 'inactive' ? undefined : await getAudioCaptureState();
    const tabId = state.tabId ?? previous?.tabId;
    await writeArea('local', { [AUDIO_CAPTURE_STATE_KEY]: { ...state, tabId, updatedAt: Date.now() } });
  });
  captureWriteChain = next.catch(() => undefined);
  return next;
}

export async function saveSessionTranscript(transcript: string): Promise<void> {
  await writeArea('local', { [TRANSCRIPT_KEY]: transcript });
}

export async function getSessionTranscript(): Promise<string> {
  const result = await readArea('local', TRANSCRIPT_KEY);
  return typeof result[TRANSCRIPT_KEY] === 'string' ? result[TRANSCRIPT_KEY] : '';
}

export async function getCaptionState(): Promise<CaptionState> {
  const result = await readArea('local', CAPTION_STATE_KEY);
  return (result[CAPTION_STATE_KEY] as CaptionState | undefined) ?? { caption: '', status: '', updatedAt: Date.now() };
}

/**
 * Ler o estado atual e escrever de volta não é atômico: duas chamadas que se
 * sobrepõem podem cada uma ler antes da outra terminar de escrever, e a
 * última a escrever apaga o que a outra tinha acabado de gravar — aconteceu
 * de verdade quando a legenda passou a ser escrita fora da fila de tradução
 * (`background/service-worker.ts`), correndo contra as escritas de status da
 * própria fila. Encadear por chamada garante que cada leitura só acontece
 * depois da escrita anterior estar de fato salva.
 */
let captionWriteChain: Promise<void> = Promise.resolve();

export function saveCaptionState(state: Partial<CaptionState>): Promise<void> {
  const next = captionWriteChain.then(async () => {
    const current = await getCaptionState();
    await writeArea('local', { [CAPTION_STATE_KEY]: { ...current, ...state, updatedAt: Date.now() } });
  });
  captionWriteChain = next.catch(() => undefined);
  return next;
}

/**
 * Zera a legenda de verdade. `saveCaptionState` faz merge com o estado atual,
 * então o `fileUrl` da última tradução sobreviveria e o avatar voltaria a tocar.
 */
export function clearCaptionState(): Promise<void> {
  const next = captionWriteChain.then(async () => {
    await writeArea('local', { [CAPTION_STATE_KEY]: { caption: '', status: '', updatedAt: Date.now() } });
  });
  captionWriteChain = next.catch(() => undefined);
  return next;
}

export async function saveSelectedText(frase: string): Promise<void> {
  await writeArea('local', { [SELECTED_TEXT_KEY]: frase });
}

export async function getSelectedText(): Promise<string> {
  const result = await readArea('local', SELECTED_TEXT_KEY);
  return typeof result[SELECTED_TEXT_KEY] === 'string' ? result[SELECTED_TEXT_KEY] : '';
}

export async function addDeveloperError(message: string, detail?: unknown): Promise<void> {
  // Também no console: o log de desenvolvedor só é visto em Configurações, e
  // se a gravação falhar (contexto morto) o erro sumiria sem deixar rastro.
  console.warn('NeoTalk [erro]', message, detail ?? '');
  const result = await readArea('local', DEVELOPER_ERRORS_KEY);
  const errors = (result[DEVELOPER_ERRORS_KEY] as DeveloperError[] | undefined) ?? [];
  const normalizedDetail = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : undefined;
  await writeArea('local', {
    [DEVELOPER_ERRORS_KEY]: [{ message, detail: normalizedDetail, createdAt: Date.now() }, ...errors].slice(0, 20)
  });
}

export async function getDeveloperErrors(): Promise<DeveloperError[]> {
  const result = await readArea('local', DEVELOPER_ERRORS_KEY);
  return (result[DEVELOPER_ERRORS_KEY] as DeveloperError[] | undefined) ?? [];
}

export async function clearDeveloperErrors(): Promise<void> {
  await writeArea('local', { [DEVELOPER_ERRORS_KEY]: [] });
}

export { AUDIO_CAPTURE_STATE_KEY, CAPTION_STATE_KEY, DEVELOPER_ERRORS_KEY, SELECTED_TEXT_KEY };
