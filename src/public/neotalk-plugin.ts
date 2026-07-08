type PhraseSource = 'welcome' | 'selection' | 'microphone' | 'tab-audio' | 'manual';
type SpeechRecognitionResultEvent = { results: { length: number; [index: number]: { [index: number]: { transcript: string } } } };
type SpeechRecognition = {
  lang: string;
  continuous: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognition;

type NeoTalkApiResponse = {
  file_url?: string;
  url?: string;
  video_url?: string;
  status_url?: string;
  statusUrl?: string;
  polling_url?: string;
  id?: string;
  job_id?: string;
  task_id?: string;
  status?: string;
  result?: NeoTalkApiResponse;
  message?: unknown;
};

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

(() => {
  const WELCOME_PHRASE = 'Seja bem-vindo!';
  const PROCESSING_MESSAGE = 'Processando tradução…';
  const EMPTY_HELPER_MESSAGE = 'Digite ou selecione um texto para traduzir.';
  const TAB_AUDIO_FALLBACK = 'Seu navegador não permite capturar diretamente o áudio desta aba. Use o microfone ou compartilhe a aba quando solicitado.';
  const API_ENDPOINT = '/api/neotalk/translate';
  const POLL_INTERVAL_MS = 2_000;
  const MAX_POLL_ATTEMPTS = 30;

  let welcomeSent = false;
  let activePhraseKey: string | null = null;
  let lastCompletedPhraseKey: string | null = null;
  let tabAudioStream: MediaStream | null = null;
  let tabAudioRecognition: SpeechRecognition | null = null;

  const host = document.createElement('div');
  host.id = 'neotalk-plugin-root';
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.appendChild(host);

  shadow.innerHTML = `
    <style>
      :host { all: initial; color-scheme: light; }
      .neotalk-plugin-shell, .neotalk-plugin-shell * { box-sizing: border-box; font-family: Arial, Helvetica, sans-serif; }
      .neotalk-plugin-toggle { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; width: 56px; height: 56px; border: 0; border-radius: 999px; background: #1447e6; color: #fff; font-weight: 700; cursor: pointer; box-shadow: 0 10px 30px rgba(15, 23, 42, .28); }
      .neotalk-plugin-panel { position: fixed; right: 20px; bottom: 88px; z-index: 2147483647; width: min(340px, calc(100vw - 32px)); max-height: calc(100vh - 112px); padding: 16px; border-radius: 18px; background: #ffffff; color: #0f172a; box-shadow: 0 16px 50px rgba(15, 23, 42, .24); transform: translateY(12px) scale(.98); opacity: 0; pointer-events: none; transition: opacity .2s ease, transform .2s ease; }
      .neotalk-plugin-panel.neotalk-plugin-open { transform: translateY(0) scale(1); opacity: 1; pointer-events: auto; }
      .neotalk-plugin-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; font-weight: 700; }
      .neotalk-plugin-close { border: 0; border-radius: 8px; background: transparent; color: #0f172a; cursor: pointer; font-size: 20px; }
      .neotalk-plugin-avatar { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 180px; height: 220px; overflow: hidden; border-radius: 14px; background: #e2e8f0; transition: height .2s ease; }
      .neotalk-plugin-avatar.neotalk-plugin-expanded { height: 300px; min-height: 180px; }
      .neotalk-plugin-video { width: 100%; height: auto; max-height: 100%; display: block; background: #000; }
      .neotalk-plugin-placeholder { padding: 16px; color: #334155; text-align: center; font-size: 14px; }
      .neotalk-plugin-caption-label { display: block; margin: 12px 0 6px; font-size: 13px; font-weight: 700; color: #1e293b; }
      .neotalk-plugin-caption { min-height: 44px; padding: 10px; border: 1px solid #cbd5e1; border-radius: 10px; background: #f8fafc; color: #0f172a; line-height: 1.4; font-size: 14px; }
      .neotalk-plugin-input { width: 100%; margin-top: 10px; padding: 10px; border: 1px solid #94a3b8; border-radius: 10px; color: #0f172a; font-size: 14px; }
      .neotalk-plugin-actions { display: grid; gap: 8px; margin-top: 10px; }
      .neotalk-plugin-button { border: 0; border-radius: 10px; padding: 10px 12px; background: #1447e6; color: #fff; font-weight: 700; cursor: pointer; }
      .neotalk-plugin-button.secondary { background: #0f172a; }
      .neotalk-plugin-status { min-height: 20px; margin-top: 8px; color: #334155; font-size: 13px; }
      .neotalk-plugin-tooltip { position: fixed; z-index: 2147483647; display: none; border: 0; border-radius: 999px; padding: 8px 12px; background: #1447e6; color: #fff; font: 700 13px Arial, Helvetica, sans-serif; cursor: pointer; box-shadow: 0 8px 24px rgba(15, 23, 42, .25); }
      .neotalk-plugin-button:focus-visible, .neotalk-plugin-toggle:focus-visible, .neotalk-plugin-close:focus-visible, .neotalk-plugin-tooltip:focus-visible, .neotalk-plugin-input:focus-visible { outline: 3px solid #facc15; outline-offset: 2px; }
    </style>
    <div class="neotalk-plugin-shell">
      <button class="neotalk-plugin-toggle" type="button" aria-label="Abrir plugin NeoTalk">Libras</button>
      <section class="neotalk-plugin-panel" aria-label="Plugin NeoTalk Libras">
        <div class="neotalk-plugin-header"><span>NeoTalk Libras</span><button class="neotalk-plugin-close" type="button" aria-label="Fechar plugin NeoTalk">×</button></div>
        <div class="neotalk-plugin-avatar neotalk-plugin-expanded" id="avatar-container">
          <video class="neotalk-plugin-video" id="avatar-video" autoplay muted loop controls playsinline></video>
          <div class="neotalk-plugin-placeholder">Avatar aguardando tradução.</div>
        </div>
        <label class="neotalk-plugin-caption-label" for="textInput">Legenda</label>
        <div class="neotalk-plugin-caption" aria-live="polite"></div>
        <input class="neotalk-plugin-input" id="textInput" type="text" placeholder="Digite ou selecione um texto para traduzir." aria-label="Texto para traduzir" />
        <div class="neotalk-plugin-actions">
          <button class="neotalk-plugin-button" id="manualButton" type="button">Traduzir para Libras</button>
          <button class="neotalk-plugin-button secondary" id="microphoneButton" type="button" aria-label="Ativar microfone">Ativar microfone</button>
          <button class="neotalk-plugin-button secondary" id="tabAudioButton" type="button">Ativar áudio da aba</button>
        </div>
        <div class="neotalk-plugin-status" aria-live="polite"></div>
      </section>
      <button class="neotalk-plugin-tooltip" type="button">Traduzir para Libras</button>
    </div>`;

  const $ = <T extends Element>(selector: string) => shadow.querySelector<T>(selector)!;
  const panel = $<HTMLElement>('.neotalk-plugin-panel');
  const toggle = $<HTMLButtonElement>('.neotalk-plugin-toggle');
  const close = $<HTMLButtonElement>('.neotalk-plugin-close');
  const tooltip = $<HTMLButtonElement>('.neotalk-plugin-tooltip');
  const caption = $<HTMLElement>('.neotalk-plugin-caption');
  const status = $<HTMLElement>('.neotalk-plugin-status');
  const input = $<HTMLInputElement>('#textInput');
  const video = $<HTMLVideoElement>('#avatar-video');
  const placeholder = $<HTMLElement>('.neotalk-plugin-placeholder');
  const tabAudioButton = $<HTMLButtonElement>('#tabAudioButton');

  function setMessage(message: string): void { status.textContent = message; }
  function openPanel(): void { panel.classList.add('neotalk-plugin-open'); toggle.setAttribute('aria-expanded', 'true'); }
  function hideTooltip(): void { tooltip.style.display = 'none'; }
  function getFileUrl(response: NeoTalkApiResponse): string | undefined { return response.file_url ?? response.url ?? response.video_url ?? response.result?.file_url; }

  async function pollForVideo(initialResponse: NeoTalkApiResponse): Promise<NeoTalkApiResponse> {
    let response = initialResponse;
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS && !getFileUrl(response); attempt += 1) {
      const pollUrl = response.status_url ?? response.statusUrl ?? response.polling_url ?? (response.id || response.job_id || response.task_id ? `/api/neotalk/status/${response.id ?? response.job_id ?? response.task_id}` : undefined);
      if (!pollUrl || response.status === 'failed' || response.status === 'error') break;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const pollResponse = await fetch(pollUrl);
      response = (await pollResponse.json()) as NeoTalkApiResponse;
    }
    return response;
  }

  function updateVideo(fileUrl: string): void {
    video.src = fileUrl;
    video.autoplay = true;
    video.muted = true;
    video.loop = true;
    video.controls = true;
    video.playsInline = true;
    placeholder.hidden = true;
    video.hidden = false;
    video.load();
    void video.play().catch(() => undefined);
  }

  async function submitPhrase(frase: string, source: PhraseSource): Promise<void> {
    if (!frase || frase.trim().length === 0) return;
    const trimmed = frase.trim();
    const phraseKey = `${source}:${trimmed}`;
    if (activePhraseKey === phraseKey || lastCompletedPhraseKey === phraseKey) return;

    activePhraseKey = phraseKey;
    caption.textContent = trimmed;
    setMessage(PROCESSING_MESSAGE);
    openPanel();

    try {
      const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frase: trimmed })
      });
      const payload = (await response.json()) as NeoTalkApiResponse;
      if (!response.ok) throw new Error(String(payload.message ?? 'Erro na tradução'));
      const finalPayload = await pollForVideo(payload);
      const fileUrl = getFileUrl(finalPayload);
      if (fileUrl) updateVideo(fileUrl);
      lastCompletedPhraseKey = phraseKey;
      setMessage('');
    } catch (error) {
      setMessage('Não foi possível processar a tradução agora.');
      if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') console.error(error);
    } finally {
      activePhraseKey = null;
    }
  }

  toggle.addEventListener('click', () => {
    panel.classList.toggle('neotalk-plugin-open');
    toggle.setAttribute('aria-expanded', String(panel.classList.contains('neotalk-plugin-open')));
  });
  close.addEventListener('click', () => panel.classList.remove('neotalk-plugin-open'));
  $('#manualButton').addEventListener('click', () => {
    if (!input.value || input.value.trim().length === 0) { setMessage(EMPTY_HELPER_MESSAGE); return; }
    void submitPhrase(input.value, 'manual');
  });

  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    const selectedText = selection?.toString().trim() ?? '';
    if (!selectedText || !selection || selection.rangeCount === 0) { hideTooltip(); return; }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    tooltip.dataset.phrase = selectedText;
    tooltip.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
    tooltip.style.top = `${Math.max(8, rect.bottom + window.scrollY + 8)}px`;
    tooltip.style.display = 'block';
  });
  tooltip.addEventListener('click', () => {
    const phrase = tooltip.dataset.phrase ?? '';
    hideTooltip();
    void submitPhrase(phrase, 'selection');
  });

  $('#microphoneButton').addEventListener('click', () => {
    const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognition) { setMessage('Seu navegador não suporta reconhecimento de voz.'); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = 'pt-BR';
    recognition.onstart = () => setMessage('Ouvindo áudio…');
    recognition.onresult = (event: SpeechRecognitionResultEvent) => {
      setMessage('Transcrevendo…');
      const texto = event.results[0][0].transcript;
      input.value = texto;
      void submitPhrase(texto, 'microphone');
    };
    recognition.onerror = () => setMessage('Seu navegador não suporta reconhecimento de voz.');
    recognition.start();
  });

  tabAudioButton.addEventListener('click', async () => {
    if (tabAudioStream) {
      tabAudioStream.getTracks().forEach((track) => track.stop());
      tabAudioStream = null;
      tabAudioRecognition?.stop();
      tabAudioButton.textContent = 'Ativar áudio da aba';
      setMessage('');
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) { setMessage(TAB_AUDIO_FALLBACK); return; }
    const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognition) { setMessage('Seu navegador não suporta reconhecimento de voz.'); return; }
    try {
      tabAudioStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      tabAudioButton.textContent = 'Desativar áudio da aba';
      setMessage('Ouvindo áudio…');
      tabAudioRecognition = new SpeechRecognition();
      tabAudioRecognition.lang = 'pt-BR';
      tabAudioRecognition.continuous = true;
      tabAudioRecognition.onresult = (event: SpeechRecognitionResultEvent) => {
        setMessage('Transcrevendo…');
        const texto = event.results[event.results.length - 1][0].transcript;
        void submitPhrase(texto, 'tab-audio');
      };
      tabAudioRecognition.start();
      tabAudioStream.getTracks().forEach((track) => track.addEventListener('ended', () => {
        tabAudioStream = null;
        tabAudioRecognition?.stop();
        tabAudioButton.textContent = 'Ativar áudio da aba';
      }));
    } catch {
      setMessage(TAB_AUDIO_FALLBACK);
    }
  });

  if (!welcomeSent) {
    welcomeSent = true;
    void submitPhrase(WELCOME_PHRASE, 'welcome');
  }
})();
