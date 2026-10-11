# Conectar o seu assistente de IA ao CRM (Claude Code ou Codex)

Para quem **administra a instalação** e quer consultar e operar o CRM conversando, pelo
terminal, com o assistente da própria assinatura:

- **Claude Code**, com a assinatura do Claude (Pro/Max);
- **Codex**, com a assinatura do ChatGPT.

Você escolhe o que melhor te atende — ou usa os dois.

## Como funciona — e por que a assinatura não entra no CRM

As assinaturas só podem ser usadas nos clientes oficiais de cada empresa (Claude Code,
Codex). Por isso o CRM nunca guarda nem usa credencial de assinatura. O caminho é o inverso:

```
Claude Code ou Codex (sua máquina, sua assinatura)  ──MCP──▶  /api/mcp do CRM  (token dsk_ de administrador)
```

Quem fala com a Anthropic ou a OpenAI é o assistente. O CRM só responde às ferramentas
(contatos, conversas, negócios, funis, agenda, tarefas…), cada chamada registrada na
auditoria como `mcp.tool_called`.

**Os agentes que atendem clientes** (WhatsApp, revenda) **continuam usando chave de API**,
em IA › Credenciais. Nada aqui muda isso.

## Conectar

1. No CRM, entre como administrador da instalação e abra **Configurações › API Tokens**.
2. Em **Conectar seu assistente de IA**, clique em **Criar token para o assistente**. O token
   nasce com `mcp:read`, `mcp:write` e `role:admin`, e vale 90 dias.
3. Escolha o assistente e copie o que a tela mostra:
   - **Claude Code**: um comando `claude mcp add …`. O token vai na configuração do Claude Code.
   - **Codex**: dois comandos, nesta ordem — o primeiro guarda o token na variável
     `CRM_MCP_TOKEN` do seu perfil do shell; o segundo (`codex mcp add …`) conecta. O Codex
     lê o token da variável, então ele não fica gravado na configuração do Codex.

   Ou, no clone do repositório, rode o comando que faz tudo isso e confere o token antes:

   ```bash
   pnpm conectar-claude --url https://crm.suaempresa.com.br
   pnpm conectar-codex  --url https://crm.suaempresa.com.br
   ```

   O token é pedido sem aparecer na tela e não vai para o histórico do shell.
4. Abra o assistente e peça, por exemplo: *"quais negócios esfriaram esta semana?"*.

O atalho aparece só para quem administra a **instalação**. O admin de uma organização de
revenda segue com os tokens de integração comuns.

## Desconectar

```bash
claude mcp remove crm -s user   # Claude Code
codex mcp remove crm            # Codex (e apague a linha CRM_MCP_TOKEN do ~/.zshrc)
```

E revogue o token em **Configurações › API Tokens**. Revogado, o CRM recusa o token na hora.

## Cuidados

- O token tem papel de **administrador**: quem o tiver opera o CRM como você. Ele fica na
  sua máquina (`~/.claude.json` no Claude Code; `~/.zshrc` no Codex, que o comando deixa
  legível só por você). Não compartilhe esses arquivos.
- Os dois assistentes pedem a sua confirmação antes de usar uma ferramenta, a menos que
  você a desligue.
- O Codex precisa estar atualizado: versões antigas não rodam os modelos da conta do
  ChatGPT (`npm i -g @openai/codex@latest`).
