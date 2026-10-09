---
impacto: capacidade_nova
secao: adicionado
titulo: Quem administra a instalação conecta o Claude Code ou o Codex ao CRM e o opera com a própria assinatura
---

Em **Configurações › API Tokens**, o administrador da instalação ganha
**Conectar seu assistente de IA**: um clique cria um token de administrador (vale 90 dias)
e mostra os comandos prontos para o Claude Code (assinatura do Claude) ou para o Codex
(assinatura do ChatGPT), à escolha. Também há `pnpm conectar-claude` e `pnpm conectar-codex`,
que pedem o token sem mostrá-lo, conferem que ele funciona e fazem a conexão. A partir daí o
assistente consulta e opera o CRM pelas ferramentas do servidor MCP. A assinatura nunca é
guardada nem usada pelo CRM; os agentes que atendem clientes continuam usando chave de API,
e o admin de uma organização de revenda não vê o atalho. Passo a passo em
`docs/conectar-assistente-de-ia.md`.
