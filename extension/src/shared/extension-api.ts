/** Resolve the extension API from the global object to avoid bundle name collisions. */
export function getExtensionApi(): typeof chrome {
  const api = globalThis.chrome;
  if (!api?.runtime) throw new Error('extension-api-unavailable');
  return api;
}

export function getExtensionStorage(): chrome.storage.StorageArea {
  const storage = getExtensionApi().storage?.local;
  if (!storage) throw new Error('extension-storage-unavailable');
  return storage;
}
