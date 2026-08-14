export const assistantTemplate = `
<button class="launcher" type="button" aria-label="Abrir assistente NeoTalk" aria-expanded="true"><strong>NT</strong><span class="launcher-state">Pronto</span><span class="badge" hidden></span></button>
<aside class="panel" aria-label="Assistente NeoTalk">
  <header><span><strong>NeoTalk</strong><small class="header-state">Pronto</small></span><nav><button class="menu" aria-label="Abrir menu" aria-expanded="false">⋯</button><button class="minimize" aria-label="Minimizar assistente">—</button></nav></header>
  <div class="menu-popover" hidden><button class="clear">Limpar conversa</button><button class="settings">Abrir configurações</button></div>
  <main class="feed" aria-label="Conversa" role="log"></main>
  <div class="announcer" aria-live="polite"></div><div class="errors" aria-live="assertive"></div>
  <footer><div class="mode" aria-live="polite">Escreva ou escolha uma fonte de áudio.</div><textarea rows="1" placeholder="Digite uma frase para traduzir…" aria-label="Mensagem para traduzir"></textarea><div class="controls"><button class="mic" aria-label="Usar meu microfone" aria-pressed="false">🎙 Microfone</button><button class="tab-audio" aria-label="Ouvir esta aba" aria-pressed="false">◉ Aba</button><button class="send">Traduzir</button></div></footer>
</aside>
<div class="selection-actions" hidden><span>Texto selecionado</span><button class="prepare">Adicionar ao assistente</button><button class="translate-now">Traduzir agora</button></div>`;
