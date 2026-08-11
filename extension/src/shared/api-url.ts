export function normalizeBaseUrl(configuredUrl: string, allowLocalHttp = false): string {
  const url = new URL(configuredUrl.trim());
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowLocalHttp && isLocal && url.protocol === 'http:')) {
    throw new Error('A URL da API deve usar HTTPS. HTTP é permitido apenas para desenvolvimento local.');
  }
  if (url.username || url.password) throw new Error('A URL da API não pode conter credenciais.');
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(sign-process-(?:pose|video|type)|task-status-(?:type|pose|video)|task-status)$/, '');
  return url.toString().replace(/\/$/, '');
}
