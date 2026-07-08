import { getPreferences, savePreferences } from '../shared/storage.js';
import type { ExtensionPreferences } from '../shared/types.js';

const form = document.querySelector<HTMLFormElement>('#optionsForm')!;
const proxyUrl = document.querySelector<HTMLInputElement>('#proxyUrl')!;
const autoWelcomeEnabled = document.querySelector<HTMLInputElement>('#autoWelcomeEnabled')!;
const captionsEnabled = document.querySelector<HTMLInputElement>('#captionsEnabled')!;
const avatarExpanded = document.querySelector<HTMLInputElement>('#avatarExpanded')!;
const status = document.querySelector<HTMLElement>('#status')!;

async function loadOptions(): Promise<void> {
  const preferences = await getPreferences();
  proxyUrl.value = preferences.proxyUrl;
  autoWelcomeEnabled.checked = preferences.autoWelcomeEnabled;
  captionsEnabled.checked = preferences.captionsEnabled;
  avatarExpanded.checked = preferences.avatarExpanded;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const preferences: ExtensionPreferences = {
    proxyUrl: proxyUrl.value.trim(),
    autoWelcomeEnabled: autoWelcomeEnabled.checked,
    captionsEnabled: captionsEnabled.checked,
    avatarExpanded: avatarExpanded.checked
  };

  void savePreferences(preferences).then(() => {
    status.textContent = 'Configurações salvas.';
  });
});

void loadOptions();
