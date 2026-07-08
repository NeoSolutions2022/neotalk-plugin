import { clearDeveloperErrors, getDeveloperErrors, getPreferences, savePreferences } from '../shared/storage.js';
import type { DeveloperError, ExtensionPreferences } from '../shared/types.js';

const form = document.querySelector<HTMLFormElement>('#optionsForm')!;
const proxyUrl = document.querySelector<HTMLInputElement>('#proxyUrl')!;
const autoWelcomeEnabled = document.querySelector<HTMLInputElement>('#autoWelcomeEnabled')!;
const captionsEnabled = document.querySelector<HTMLInputElement>('#captionsEnabled')!;
const avatarExpanded = document.querySelector<HTMLInputElement>('#avatarExpanded')!;
const developerMode = document.querySelector<HTMLInputElement>('#developerMode')!;
const apiKey = document.querySelector<HTMLInputElement>('#apiKey')!;
const toggleDeveloperErrors = document.querySelector<HTMLButtonElement>('#toggleDeveloperErrors')!;
const clearDeveloperErrorsButton = document.querySelector<HTMLButtonElement>('#clearDeveloperErrors')!;
const developerErrors = document.querySelector<HTMLPreElement>('#developerErrors')!;
const status = document.querySelector<HTMLElement>('#status')!;

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
  developerMode.checked = preferences.developerMode;
  apiKey.value = preferences.apiKey;
  apiKey.disabled = !preferences.developerMode;
  await renderDeveloperErrors();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const preferences: ExtensionPreferences = {
    proxyUrl: proxyUrl.value.trim(),
    autoWelcomeEnabled: autoWelcomeEnabled.checked,
    captionsEnabled: captionsEnabled.checked,
    avatarExpanded: avatarExpanded.checked,
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

void loadOptions();
