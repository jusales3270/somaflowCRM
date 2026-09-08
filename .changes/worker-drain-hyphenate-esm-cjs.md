---
impacto: nada_mudou
secao: corrigido
titulo: O laço rápido do worker volta a montar o admin client
---

`@react-pdf/hyphenate` é ESM puro e não expunha a condição `require` no seu `exports`. Como o worker roda via `tsx` (CommonJS), qualquer import de `@react-pdf/renderer` (usado pela exportação de dados LGPD) derrubava `carregarDeps()` do drain loop com `ERR_PACKAGE_PATH_NOT_EXPORTED` — e como `register-handlers.ts` registra os 12 handlers do `event_log` num só import chain, isso tirava o laço rápido de TODOS eles, não só do LGPD, caindo pro cron de 1×/min como única rede de segurança.

Patch (`patches/@react-pdf__hyphenate.patch`) acrescenta a condição `require` ao exports map — Node 22.12+/24 já sabe carregar ESM via `require()` quando o mapa permite. Provado no worker real: o warning "event-log drain OFF" some do log de boot.
