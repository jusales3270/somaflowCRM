/**
 * Conectar o assistente de IA de quem administra a instalação — Claude Code ou Codex —
 * ao servidor MCP do CRM.
 *
 * ─── Por que existe, e o que ele NÃO é ──────────────────────────────────────
 *
 * O dono da instalação quer operar o CRM com o assistente da assinatura DELE (Claude
 * Pro/Max ou ChatGPT). Os termos de Anthropic e OpenAI permitem a assinatura nos
 * clientes oficiais delas (Claude Code, Codex), não dentro de outro produto: este
 * módulo NUNCA guarda, lê ou repassa credencial de assinatura. Ele só monta a conexão
 * no sentido inverso — o assistente, rodando na máquina de quem administra, chama o
 * `/api/mcp` daqui com um token `dsk_` que só o administrador emite. Quem fala com a
 * Anthropic ou a OpenAI é o assistente; o CRM só responde ferramentas.
 *
 * Os agentes que atendem no WhatsApp continuam usando CHAVE DE API (IA › Credenciais);
 * nada aqui muda esse caminho.
 *
 * ─── Os dois clientes guardam o token de jeitos diferentes ──────────────────
 *
 * - Claude Code: `claude mcp add … --header "Authorization: Bearer <token>"` grava o
 *   cabeçalho na configuração do usuário.
 * - Codex: `codex mcp add … --bearer-token-env-var <VAR>` grava só o NOME da variável;
 *   o token fica numa variável de ambiente (no perfil do shell). Medido no Codex
 *   0.162: o `config.toml` não recebe o token.
 *
 * ─── Por que módulo puro ────────────────────────────────────────────────────
 *
 * A tela de API Tokens e o `scripts/conectar-assistente.ts` montam os MESMOS comandos.
 * Se cada um escrevesse o seu, o dia em que um formato mudasse um dos dois ensinaria o
 * comando errado.
 */

export type ClienteDeAssistente = "claude" | "codex";

/** Os escopos do token: ler e agir no CRM, com o papel de admin. */
export const ESCOPOS_DO_ASSISTENTE = ["mcp:read", "mcp:write", "role:admin"] as const;

/** Validade padrão do token: curta o bastante para não virar credencial eterna. */
export const VALIDADE_DO_TOKEN_DO_ASSISTENTE_DIAS = 90;

/** Nome do servidor no assistente. Neutro de marca: serve a qualquer instalação. */
export const NOME_DO_SERVIDOR_MCP = "crm";

/** A variável de ambiente de onde o Codex lê o token. */
export const VARIAVEL_DO_TOKEN_NO_CODEX = "CRM_MCP_TOKEN";

/** O formato que `app/api/v1/settings/api-tokens/route.ts` emite: `dsk_<8 hex>_<base64url>`. */
const FORMATO_DO_TOKEN = /^dsk_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}$/;

export function tokenTemFormatoValido(token: string): boolean {
  return FORMATO_DO_TOKEN.test(token.trim());
}

/**
 * O endereço do MCP a partir da URL pública da instalação. Aceita a URL com ou sem
 * barra final; recusa o que não for http(s), para o comando nunca nascer com um
 * endereço que o assistente não alcança.
 */
export function urlDoMcp(urlDaInstalacao: string): string {
  const url = new URL(urlDaInstalacao.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`URL da instalação precisa ser http(s): ${urlDaInstalacao}`);
  }
  return `${url.origin}/api/mcp`;
}

interface OpcoesDaConexao {
  urlDaInstalacao: string;
  token: string;
  nome?: string;
}

/**
 * Os argumentos do `claude mcp add`, em lista — para o script passar a `execFile`
 * sem shell (o token não passa por interpretação nem fica no histórico).
 */
export function argumentosDoClaudeMcpAdd(opcoes: OpcoesDaConexao): string[] {
  return [
    "mcp",
    "add",
    "--scope",
    "user",
    "--transport",
    "http",
    opcoes.nome ?? NOME_DO_SERVIDOR_MCP,
    urlDoMcp(opcoes.urlDaInstalacao),
    "--header",
    `Authorization: Bearer ${opcoes.token.trim()}`,
  ];
}

/** Os argumentos do `codex mcp add`. Sem token: o Codex o lê da variável de ambiente. */
export function argumentosDoCodexMcpAdd(opcoes: Omit<OpcoesDaConexao, "token">): string[] {
  return [
    "mcp",
    "add",
    opcoes.nome ?? NOME_DO_SERVIDOR_MCP,
    "--url",
    urlDoMcp(opcoes.urlDaInstalacao),
    "--bearer-token-env-var",
    VARIAVEL_DO_TOKEN_NO_CODEX,
  ];
}

function comoComando(programa: string, args: string[]): string {
  const comAspas = (a: string) =>
    /[\s"'$`\\]/.test(a) ? `"${a.replace(/(["$`\\])/g, "\\$1")}"` : a;
  return [programa, ...args.map(comAspas)].join(" ");
}

/** O comando do Claude Code pronto para colar no terminal. */
export function comandoDoClaudeMcpAdd(opcoes: OpcoesDaConexao): string {
  return comoComando("claude", argumentosDoClaudeMcpAdd(opcoes));
}

/**
 * Os comandos do Codex: a linha que guarda o token no perfil do shell e o
 * `codex mcp add`. Na ordem em que devem ser colados.
 */
export function comandosDoCodex(opcoes: OpcoesDaConexao): string[] {
  return [
    `echo 'export ${VARIAVEL_DO_TOKEN_NO_CODEX}="${opcoes.token.trim()}"' >> ~/.zshrc && source ~/.zshrc`,
    comoComando("codex", argumentosDoCodexMcpAdd(opcoes)),
  ];
}
