# Reconciliação — NeoTalk Libras

Esta branch parte de `feature/transcricao-audio-libras` e adiciona por cima o
que faltava. Documento de referência para retomar o trabalho sem reconstruir o
contexto.

## Objetivo

1. Transcrição quase perfeita do **áudio da aba** e do **microfone**.
2. Passagem limpa das frases para a API, e retorno limpo.
3. **Sem alterar endpoints nem regras do Docker.**
4. O **balão** é a interface principal; todos os botões vivem nele.

## Como as duas linhas de trabalho se juntaram

Existiam duas implementações partindo do mesmo commit (`3855098`), feitas em
paralelo e sem conhecimento uma da outra. Chegaram à mesma arquitetura —
esbuild, transformers.js com Whisper, CSP com `wasm-unsafe-eval` — e cada uma
resolveu problemas que a outra não tinha resolvido.

**Veio de `feature/transcricao-audio-libras` (a base):**

- `api-url.ts` — valida HTTPS, recusa credenciais na URL, limpa query e hash.
- `api-response.ts` — `getTaskId` recusa palavras de status como identificador.
- `transcript.ts` — filtra artefatos de alucinação do Whisper (`[música]`,
  `obrigado por assistir`) e remove sobreposição entre blocos consecutivos.
- Sessão de captura com `MediaRecorder`, fila com limite e `sessionId`/`sequence`
  garantindo ordem de envio.
- Parâmetros anti-alucinação no decoder (`repetition_penalty`,
  `no_repeat_ngram_size`).
- Migração da chave da API para `storage.local`.

**Foi adicionado por cima:**

- Segmentação por fala (`speech-segmenter.ts`) no lugar do corte fixo de 15 s.
- Guardas de transição do estado de captura (`capture-guard.ts`).
- Os dois botões de captura no balão, com verde/âmbar/vermelho.
- `sanitizePhrase` no caminho do texto vindo da página.
- CI com typecheck, lint, build e testes.

## Por que a segmentação por fala substituiu o corte de 15 segundos

O corte fixo causava três problemas: até 15 segundos de espera antes de uma
frase começar a ser transcrita, corte no meio de palavras, e blocos de puro
silêncio indo ao Whisper — que é justamente o que produz as alucinações
filtradas em `KNOWN_SILENCE_ARTIFACTS`.

O segmentador fecha o trecho na pausa natural da fala e descarta trechos sem
fala antes de chegarem ao modelo, atacando a alucinação na origem. O filtro de
artefatos continua valendo como segunda linha de defesa.

A medição usa `AnalyserNode`, e não `ScriptProcessorNode`, que está obsoleto.

## Botões do balão

Só uma fonte fica ativa por vez — transcrições simultâneas chegariam
sobrepostas na API.

| Estado | Cor | Texto | Clicável |
|---|---|---|---|
| Parado | verde | "Microfone" | sim |
| Preparando / carregando modelo | âmbar | "Preparando..." | não |
| Gravando / transcrevendo | vermelho | "Parar microfone" | sim |
| Parando | âmbar | "Parando..." | não |

A cor nunca é o único indicador: ícone, texto e `aria-pressed` mudam junto.

## O que ainda não foi feito

- Polling de até 60 s no service worker deveria migrar para `chrome.alarms`,
  com o estado da task persistido e retomada após reinício.
- `fetch` sem `AbortController`/timeout: request pendurado trava o fluxo.
- `activeSubmissions` usa `origem:texto` como chave e devolve `undefined` ao
  duplicar, o que o chamador interpreta como falha.
- Balão injetado em `<all_urls>` sem allowlist por site.
- Qualidade da transcrição precisa ser calibrada com áudio real. O modelo é
  `Xenova/whisper-base`; `whisper-small` costuma ser o mínimo para
  "quase perfeito" em pt-BR.
- `expandNumbers` do `sanitizePhrase` está desligado até sabermos como a API
  trata dígitos.

## Verificação

```bash
npm ci
npm run typecheck
npm run lint
npm run build
npm test
```

Os botões do balão foram verificados num Chromium real com a extensão
carregada: cor computada de cada fase, botão desabilitado nas transições,
watchdog destravando transição sem confirmação, e captura de outra aba não
afetando a aba atual.

O que depende de teste manual, com áudio e API reais: qualidade da
transcrição, permissão de microfone e o retorno da API NeoTalk.
