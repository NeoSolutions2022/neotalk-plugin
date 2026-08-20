/**
 * Ponte entre o balão (content script) e o widget 3D do Avatar3D.
 *
 * Existe por duas razões independentes, e as duas são obrigatórias:
 *
 * 1. **CSP da página hospedeira.** O balão é injetado em `<all_urls>`, e um
 *    `<iframe>` para domínio externo criado por content script obedece ao
 *    `frame-src` da página. Em sites com CSP restrito o avatar não carregaria.
 *    Recursos declarados em `web_accessible_resources` são isentos desse CSP, e
 *    dentro desta página o CSP passa a ser o da extensão — que não restringe
 *    `frame-src`.
 * 2. **O widget exige um pai direto.** Ele só aceita comandos cujo
 *    `event.source === window.parent`. Esta página é esse pai.
 *
 * Segurança: o `window.parent` desta página é a página do usuário, e o widget
 * aceita comandos de qualquer origem (`allowed_origins: ["*"]`). Sem proteção,
 * qualquer script daquela página poderia fazer o avatar sinalizar texto
 * arbitrário. O content script gera um token por sessão e o passa no hash; toda
 * mensagem sem ele é descartada.
 */

const params = new URLSearchParams(location.hash.slice(1));
const token = params.get('token') ?? '';
const avatarName = params.get('avatar') === 'asuna' ? 'asuna' : 'lia';
const parentOrigin = params.get('parentOrigin') || '*';

const widget = document.querySelector<HTMLIFrameElement>('#widget')!;
const fallback = document.querySelector<HTMLElement>('#fallback')!;

function fail(message: string): void {
  fallback.textContent = message;
  fallback.hidden = false;
  widget.hidden = true;
}

function widgetOrigin(): string | null {
  try {
    return new URL(widget.src).origin;
  } catch {
    return null;
  }
}

/** Só o que o content script mandou, e só se trouxer o token desta sessão. */
function isTrustedCommand(event: MessageEvent): boolean {
  if (event.source !== window.parent) return false;
  const data = event.data as { neotalkToken?: unknown; type?: unknown } | null;
  if (!data || typeof data !== 'object') return false;
  if (!token || data.neotalkToken !== token) return false;
  return typeof data.type === 'string' && data.type.startsWith('neotalk:');
}

function isWidgetEvent(event: MessageEvent): boolean {
  const origin = widgetOrigin();
  if (!origin || event.origin !== origin) return false;
  if (event.source !== widget.contentWindow) return false;
  const data = event.data as { type?: unknown } | null;
  if (!data || typeof data !== 'object') return false;
  return typeof data.type === 'string' && data.type.startsWith('neotalk:');
}

window.addEventListener('message', (event) => {
  if (isTrustedCommand(event)) {
    const origin = widgetOrigin();
    if (!origin || !widget.contentWindow) return;
    // O token não segue adiante: ele é o segredo entre o balão e esta ponte, e o
    // widget não tem nada que ver com ele.
    const { neotalkToken: _drop, ...command } = event.data as Record<string, unknown>;
    void _drop;
    widget.contentWindow.postMessage(command, origin);
    return;
  }

  if (isWidgetEvent(event)) {
    // De volta ao balão com o token, para o content script saber que o evento
    // veio desta ponte e não de um script qualquer da página.
    window.parent.postMessage({ ...(event.data as Record<string, unknown>), neotalkToken: token }, parentOrigin);
  }
});

function start(): void {
  const base = params.get('base') ?? '';
  let url: URL;
  try {
    url = new URL('/widget', base);
  } catch {
    fail('Endereço do avatar 3D inválido. Confira o campo nas Opções da extensão.');
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail('Endereço do avatar 3D inválido. Confira o campo nas Opções da extensão.');
    return;
  }

  url.searchParams.set('avatar', avatarName);
  // `loop=0` é essencial: o padrão do widget repete o sinal para sempre, e a fila
  // do balão nunca saberia que pode mandar a próxima frase.
  url.searchParams.set('loop', '0');
  url.searchParams.set('background', '#ffffff');

  widget.addEventListener('load', () => {
    widget.hidden = false;
    fallback.hidden = true;
  });
  widget.addEventListener('error', () => fail('Não foi possível carregar o avatar 3D.'));
  widget.src = url.toString();
}

start();
