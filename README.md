# NeoTalk Libras Chrome Extension

Extensão Chrome Manifest V3 para traduzir texto selecionado, fala do microfone e tentativa de áudio da aba atual para Libras com avatar NeoTalk.

## Arquitetura

```txt
extension/
  manifest.json
  src/background/service-worker.ts
  src/content/content-script.ts
  src/popup/popup.html
  src/popup/popup.ts
  src/popup/popup.css
  src/options/options.html
  src/options/options.ts
  src/options/options.css
  src/offscreen/offscreen.html
  src/offscreen/offscreen.ts
  src/shared/
```

## Segurança

A extensão não contém uma chave real hardcoded e, em produção, não deve chamar a API externa diretamente com chave privada. Configure uma URL de proxy/backend NeoTalk na tela de configurações. O proxy deve receber `{ "frase": "texto" }`, chamar a API externa no servidor e adicionar a chave privada com segurança. Para desenvolvimento local, o modo desenvolvedor permite informar temporariamente uma chave da API, mas isso é inseguro porque qualquer dado salvo na extensão pode ser inspecionado pelo usuário.

URL padrão configurável:

```txt
https://api.neotalk.com/extension/sign-process-pose
```

## Desenvolvimento

```bash
npm install
npm run typecheck
npm run lint
npm run build
```

## Carregar no Chrome

1. Execute `npm run build` para gerar `extension/dist`.
2. Abra `chrome://extensions`.
3. Ative o "Modo do desenvolvedor".
4. Clique em "Carregar sem compactação".
5. Selecione a pasta `extension/` deste repositório.
6. Abra "Configurações" na extensão e ajuste a URL do proxy NeoTalk, se necessário.
7. Use "Modo desenvolvedor" apenas para testes locais com chave temporária e para visualizar/limpar erros técnicos registrados.

## Limitações de navegador

- Captura de áudio da aba só começa após clique explícito em “Ativar áudio da aba”.
- `chrome.tabCapture`, documentos offscreen e Web Speech API dependem de suporte/permissões do Chrome.
- A Web Speech API não permite transcrição silenciosa garantida de todo áudio interno; quando indisponível, a extensão mostra a mensagem de fallback em português.
