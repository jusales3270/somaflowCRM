---
impacto: capacidade_nova
secao: adicionado
titulo: Quem administra a instalação conecta o Claude Code ao CRM e o opera com a própria assinatura do Claude
---

Em **Configurações › API Tokens**, o administrador da instalação ganha
**Conectar ao Claude Code**: um clique cria um token de administrador (vale 90 dias) e mostra o comando
`claude mcp add` pronto para colar no terminal. Também há o `pnpm conectar-claude`, que pede
o token sem mostrá-lo, confere que ele funciona e faz a conexão. A partir daí o Claude Code,
com a assinatura de quem administra, consulta e opera o CRM pelas ferramentas do servidor MCP.
A assinatura nunca é guardada nem usada pelo CRM; os agentes que atendem clientes continuam
usando chave de API, e o admin de uma organização de revenda não vê o atalho.
Passo a passo em `docs/conectar-claude-code.md`.
