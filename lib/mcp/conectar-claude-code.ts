/**
 * Conectar o Claude Code de quem administra a instalação ao servidor MCP do CRM.
 *
 * ─── Por que existe, e o que ele NÃO é ──────────────────────────────────────
 *
 * O dono da instalação quer operar o CRM com o Claude da assinatura DELE. O que
 * os termos da Anthropic permitem é a assinatura ser usada no Claude Code (o
 * cliente oficial), não dentro de outro produto: este módulo NUNCA guarda, lê
 * ou repassa credencial de assinatura. Ele só monta a conexão no sentido
 * inverso — o Claude Code, rodando na máquina de quem administra, chama o
 * `/api/mcp` daqui com um token `dsk_` que só o administrador emite. Quem fala
 * com a Anthropic é o Claude Code; o CRM só responde ferramentas.
 *
 * Os agentes que atendem no WhatsApp continuam usando CHAVE DE API (IA ›
 * Credenciais); nada aqui muda esse caminho.
 *
 * ─── Por que módulo puro ────────────────────────────────────────────────────
 *
 * A tela de API Tokens e o `scripts/conectar-claude.ts` montam o MESMO comando.
 * Se cada um escrevesse o seu, o dia em que o formato do `claude mcp add` mudasse
 * um dos dois ensinaria o comando errado.
 */

/** Os escopos do token do Claude Code: ler e agir no CRM, com o papel de admin. */
export const ESCOPOS_DO_CLAUDE_CODE = ["mcp:read", "mcp:write", "role:admin"] as const;

/** Validade padrão do token: curta o bastante para não virar credencial eterna. */
export const VALIDADE_DO_TOKEN_DO_CLAUDE_CODE_DIAS = 90;

/** Nome do servidor no Claude Code. Neutro de marca: serve a qualquer instalação. */
export const NOME_DO_SERVIDOR_MCP = "crm";

/** O formato que `app/api/v1/settings/api-tokens/route.ts` emite: `dsk_<8 hex>_<base64url>`. */
const FORMATO_DO_TOKEN = /^dsk_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}$/;

export function tokenTemFormatoValido(token: string): boolean {
  return FORMATO_DO_TOKEN.test(token.trim());
}

/**
 * O endereço do MCP a partir da URL pública da instalação. Aceita a URL com ou
 * sem barra final; recusa o que não for http(s), para o comando nunca nascer
 * com um endereço que o Claude Code não alcança.
 */
export function urlDoMcp(urlDaInstalacao: string): string {
  const url = new URL(urlDaInstalacao.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`URL da instalação precisa ser http(s): ${urlDaInstalacao}`);
  }
  return `${url.origin}/api/mcp`;
}

/**
 * Os argumentos do `claude mcp add`, em lista — para o script passar a
 * `execFile` sem shell (o token não passa por interpretação nem fica no
 * histórico) e para a tela mostrar a mesma coisa como texto.
 */
export function argumentosDoClaudeMcpAdd(opcoes: {
  urlDaInstalacao: string;
  token: string;
  nome?: string;
}): string[] {
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

/** O comando pronto para colar no terminal, com aspas onde o shell exige. */
export function comandoDoClaudeMcpAdd(opcoes: {
  urlDaInstalacao: string;
  token: string;
  nome?: string;
}): string {
  const args = argumentosDoClaudeMcpAdd(opcoes);
  return [
    "claude",
    ...args.map((a) => (/[\s"'$`\\]/.test(a) ? `"${a.replace(/(["$`\\])/g, "\\$1")}"` : a)),
  ].join(" ");
}
