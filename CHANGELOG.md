# Changelog

## 1.3.0

- Usa a URL padrão `https://infra-neotalk-api.k3p3ex.easypanel.host/sign-process-pose` sem anexar `/sign-process-type`.
- Adiciona janela flutuante e arrastável de modo seleção no navegador.
- Envia `Seja bem-vindo` ao abrir a extensão e mantém o vídeo retornado até nova solicitação.

## 1.2.0

- Integra o fluxo assíncrono `/sign-process-type` + `/task-status-type/<task_id>`.
- Adiciona modo seleção automático para enviar texto selecionado sem depender do popup aberto.
- Atualiza a URL configurável para representar a URL base do proxy/API.

## 1.1.0

- Corrige a seleção de texto em páginas usando content script clássico e tooltip isolado em Shadow DOM.
- Envia traduções como `FormData` com o campo `frase`.
- Melhora a responsividade e o visual do popup da extensão.
- Mantém suporte ao modo desenvolvedor para chave temporária e visualização de erros técnicos.

## 1.0.0

- Versão inicial da extensão Chrome Manifest V3 NeoTalk Libras.
