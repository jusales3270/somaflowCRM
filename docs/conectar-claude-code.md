# Conectar o Claude Code ao CRM

Para quem **administra a instalação** e quer consultar e operar o CRM conversando com o
Claude da própria assinatura (Pro/Max), pelo terminal.

## Como funciona — e por que a assinatura não entra no CRM

A assinatura do Claude só pode ser usada nos apps da Anthropic e no **Claude Code**. Por
isso o CRM nunca guarda nem usa credencial de assinatura. O caminho é o inverso:

```
Claude Code (sua máquina, sua assinatura)  ──MCP──▶  /api/mcp do CRM  (token dsk_ de administrador)
```

Quem fala com a Anthropic é o Claude Code. O CRM só responde às ferramentas (contatos,
conversas, negócios, funis, agenda, tarefas…), cada chamada registrada na auditoria como
`mcp.tool_called`.

**Os agentes que atendem clientes** (WhatsApp, revenda) **continuam usando chave de API**,
em IA › Credenciais. Nada aqui muda isso.

## Conectar

Requisito: [Claude Code](https://claude.com/claude-code) instalado e logado na sua assinatura.

1. No CRM, entre como administrador da instalação e abra **Configurações › API Tokens**.
2. Em **Conectar ao Claude Code**, clique em **Criar token para o Claude Code**. O token
   nasce com `mcp:read`, `mcp:write` e `role:admin`, e vale 90 dias.
3. Copie o comando que aparece e cole no terminal da sua máquina. Ou, no clone do
   repositório, rode `pnpm conectar-claude --url https://crm.suaempresa.com.br` e cole o
   token quando ele pedir (o token não aparece na tela nem vai para o histórico do shell).
4. Abra o Claude Code e peça, por exemplo: *"quais negócios esfriaram esta semana?"*.

O atalho aparece só para quem administra a **instalação**. O admin de uma organização de
revenda segue com os tokens de integração comuns.

## Desconectar

```bash
claude mcp remove crm -s user
```

E revogue o token em **Configurações › API Tokens**. Revogado, o CRM recusa o token na hora.

## Cuidados

- O token tem papel de **administrador**: quem o tiver opera o CRM como você. O Claude Code
  o guarda na sua máquina (`~/.claude.json`); não compartilhe esse arquivo.
- Antes de ações de escrita (criar, mover, enviar mensagem), o Claude Code pede a sua
  confirmação, a menos que você a desligue.
