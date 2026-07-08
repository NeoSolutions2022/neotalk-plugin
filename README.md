# neotalk-plugin

Widget JavaScript/TypeScript para traduzir textos selecionados, fala do microfone e áudio compartilhado de aba para Libras usando a API NeoTalk por meio de um proxy interno seguro.

## Ambiente

Configure as variáveis no servidor ou no Docker. A chave nunca deve ser exposta no bundle do navegador.

```env
NEOTALK_API_URL=https://neotalks-neotalk.t2wird.easypanel.host
NEOTALK_API_KEY=<fornecida-em-build-ou-runtime>
PORT=3000
```

## Rotas

- `POST /api/neotalk/translate`: recebe `{ "frase": "texto" }`, valida o conteúdo e encaminha para `${NEOTALK_API_URL}/sign-process-pose` com o cabeçalho `x-api-key` no servidor.
- `GET /api/neotalk/status/:id`: endpoint de compatibilidade para fluxos assíncronos/polling quando a API retorna um identificador de job.

## Plugin

Após o build, sirva o script em `/plugin/neotalk-plugin.js` e injete-o na página onde o widget deve estar ativo.
