import { clearDeveloperErrors, getDeveloperErrors, getPreferences, savePreferences } from '../shared/storage.js';
import type { DeveloperError, ExtensionPreferences } from '../shared/types.js';

const form = document.querySelector<HTMLFormElement>('#optionsForm')!;
const proxyUrl = document.querySelector<HTMLInputElement>('#proxyUrl')!;
const autoWelcomeEnabled = document.querySelector<HTMLInputElement>('#autoWelcomeEnabled')!;
const captionsEnabled = document.querySelector<HTMLInputElement>('#captionsEnabled')!;
const avatarExpanded = document.querySelector<HTMLInputElement>('#avatarExpanded')!;
const selectionModeEnabled = document.querySelector<HTMLInputElement>('#selectionModeEnabled')!;
const autoSubmitSelection = document.querySelector<HTMLInputElement>('#autoSubmitSelection')!;
const developerMode = document.querySelector<HTMLInputElement>('#developerMode')!;
const apiKey = document.querySelector<HTMLInputElement>('#apiKey')!;
const toggleDeveloperErrors = document.querySelector<HTMLButtonElement>('#toggleDeveloperErrors')!;
const clearDeveloperErrorsButton = document.querySelector<HTMLButtonElement>('#clearDeveloperErrors')!;
const developerErrors = document.querySelector<HTMLPreElement>('#developerErrors')!;
const status = document.querySelector<HTMLElement>('#status')!;
const microphonePermissionButton = document.querySelector<HTMLButtonElement>('#microphonePermissionButton')!;
const microphonePermissionStatus = document.querySelector<HTMLElement>('#microphonePermissionStatus')!;

function formatDeveloperErrors(errors: DeveloperError[]): string {
  if (errors.length === 0) return 'Nenhum erro técnico registrado.';

  return errors
    .map((error) => {
      const date = new Date(error.createdAt).toLocaleString('pt-BR');
      return `[${date}] ${error.message}${error.detail ? `\n${error.detail}` : ''}`;
    })
    .join('\n\n');
}

async function renderDeveloperErrors(): Promise<void> {
  developerErrors.textContent = formatDeveloperErrors(await getDeveloperErrors());
}

async function loadOptions(): Promise<void> {
  const preferences = await getPreferences();
  proxyUrl.value = preferences.proxyUrl;
  autoWelcomeEnabled.checked = preferences.autoWelcomeEnabled;
  captionsEnabled.checked = preferences.captionsEnabled;
  avatarExpanded.checked = preferences.avatarExpanded;
  selectionModeEnabled.checked = preferences.selectionModeEnabled;
  autoSubmitSelection.checked = preferences.autoSubmitSelection;
  developerMode.checked = preferences.developerMode;
  apiKey.value = preferences.apiKey;
  apiKey.disabled = !preferences.developerMode;
  await renderDeveloperErrors();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  let normalizedUrl: string;
  try {
    const parsed = new URL(proxyUrl.value.trim());
    const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && developerMode.checked;
    if (parsed.protocol !== 'https:' && !localHttp) throw new Error();
    if (parsed.username || parsed.password) throw new Error();
    normalizedUrl = parsed.toString().replace(/\/$/, '');
  } catch {
    status.textContent = 'Informe uma URL HTTPS válida. HTTP só é permitido para desenvolvimento local.';
    return;
  }
  const preferences: ExtensionPreferences = {
    proxyUrl: normalizedUrl,
    autoWelcomeEnabled: autoWelcomeEnabled.checked,
    captionsEnabled: captionsEnabled.checked,
    avatarExpanded: avatarExpanded.checked,
    selectionModeEnabled: selectionModeEnabled.checked,
    autoSubmitSelection: autoSubmitSelection.checked,
    developerMode: developerMode.checked,
    apiKey: developerMode.checked ? apiKey.value.trim() : ''
  };

  void savePreferences(preferences).then(() => {
    status.textContent = 'Configurações salvas.';
  });
});

developerMode.addEventListener('change', () => {
  apiKey.disabled = !developerMode.checked;
  if (!developerMode.checked) apiKey.value = '';
});

toggleDeveloperErrors.addEventListener('click', () => {
  developerErrors.hidden = !developerErrors.hidden;
  void renderDeveloperErrors();
});

clearDeveloperErrorsButton.addEventListener('click', () => {
  void clearDeveloperErrors().then(renderDeveloperErrors);
});

microphonePermissionButton.addEventListener('click', () => {
  void (async () => {
    microphonePermissionStatus.textContent = 'Solicitando permissão...';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      microphonePermissionStatus.textContent = 'Microfone autorizado com sucesso! Você já pode usar o botão de microfone na extensão.';
    } catch (error) {
      console.warn('NeoTalk: falha ao autorizar microfone.', error);
      microphonePermissionStatus.textContent = 'Não foi possível autorizar o microfone. Verifique as permissões do navegador e tente novamente.';
    }
  })();
});

void loadOptions();
