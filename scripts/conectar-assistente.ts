/**
 * `pnpm conectar-claude` / `pnpm conectar-codex` — conecta o assistente de IA de quem
 * administra a instalação (Claude Code ou Codex) ao servidor MCP do CRM.
 *
 * O token `dsk_` é criado em Configurações › API Tokens › "Criar token para o
 * assistente" (só administrador da instalação). Este script:
 *
 *   1. confere que o assistente escolhido está instalado;
 *   2. pede o token num prompt OCULTO — nunca por argumento, que iria para o
 *      histórico do shell e para a lista de processos;
 *   3. prova que o token funciona chamando `initialize` no `/api/mcp`;
 *   4. só então configura o assistente, sem shell no meio:
 *      - Claude Code: `claude mcp add` (o token vai no cabeçalho da config do usuário);
 *      - Codex: `codex mcp add --bearer-token-env-var CRM_MCP_TOKEN` e grava
 *        `export CRM_MCP_TOKEN=…` no perfil do shell (o Codex lê o token de lá).
 *
 * A assinatura nunca passa por aqui: ela fica no assistente, e é ele quem fala com a
 * Anthropic ou a OpenAI. Ver `lib/mcp/conectar-assistente.ts`.
 *
 * Uso: pnpm conectar-claude | pnpm conectar-codex  [--url https://crm.suaempresa.com.br] [--nome crm]
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import {
  argumentosDoClaudeMcpAdd,
  argumentosDoCodexMcpAdd,
  type ClienteDeAssistente,
  NOME_DO_SERVIDOR_MCP,
  tokenTemFormatoValido,
  urlDoMcp,
  VARIAVEL_DO_TOKEN_NO_CODEX,
} from "@/lib/mcp/conectar-assistente";

function argumento(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function falhar(mensagem: string): never {
  console.error(`\n✖ ${mensagem}\n`);
  process.exit(1);
}

/** Lê uma linha sem ecoar o que é digitado (o token não aparece na tela). */
function perguntarOculto(pergunta: string): Promise<string> {
  return new Promise((resolve) => {
    // Terminal de verdade: sem eco. Entrada canalizada (`echo dsk_… | pnpm conectar-codex`):
    // `terminal: false`, senão o readline trata o pipe como TTY e escreve controles.
    const interativo = Boolean(process.stdin.isTTY);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: interativo,
    });
    let respondeu = false;
    const responder = (texto: string) => {
      if (respondeu) return;
      respondeu = true;
      process.stdout.write("\n");
      resolve(texto.trim());
    };
    process.stdout.write(pergunta);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    rl.on("line", (linha) => {
      responder(linha);
      rl.close();
    });
    // Entrada que termina SEM quebra de linha (token colado de um arquivo) não dispara
    // `line`: sem isto o script encerrava em silêncio, sem conectar nem avisar.
    let parcial = "";
    if (!interativo) process.stdin.on("data", (c) => (parcial += String(c)));
    rl.on("close", () => responder(parcial.split(/\r?\n/)[0] ?? ""));
  });
}

async function provarToken(endereco: string, token: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(endereco, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "conectar-assistente", version: "1" },
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    falhar(`Não consegui falar com ${endereco}. O CRM está no ar nesse endereço?`);
  }
  if (res.status === 401 || res.status === 403) {
    falhar(
      "O CRM recusou o token (inválido, revogado ou expirado). Crie outro em Configurações › API Tokens.",
    );
  }
  if (!res.ok) falhar(`O CRM respondeu ${res.status} em ${endereco}.`);
  const corpo = await res.text();
  if (!corpo.includes('"serverInfo"'))
    falhar(`${endereco} respondeu, mas não como um servidor MCP.`);
}

const ASSISTENTES: Record<
  ClienteDeAssistente,
  { programa: string; nome: string; instalar: string }
> = {
  claude: { programa: "claude", nome: "Claude Code", instalar: "https://claude.com/claude-code" },
  codex: { programa: "codex", nome: "Codex", instalar: "npm i -g @openai/codex" },
};

/**
 * Grava `export CRM_MCP_TOKEN="…"` no perfil do shell, TROCANDO a linha se ela já
 * existir (token renovado) em vez de acumular uma por execução. Devolve o caminho.
 */
function gravarTokenNoPerfil(token: string): string {
  const perfil = path.join(
    os.homedir(),
    (process.env.SHELL ?? "").endsWith("bash") ? ".bashrc" : ".zshrc",
  );
  const linha = `export ${VARIAVEL_DO_TOKEN_NO_CODEX}="${token}"`;
  const atual = fs.existsSync(perfil) ? fs.readFileSync(perfil, "utf8") : "";
  const padrao = new RegExp(`^export ${VARIAVEL_DO_TOKEN_NO_CODEX}=.*$`, "m");
  const novo = padrao.test(atual)
    ? atual.replace(padrao, linha)
    : `${atual}${atual.endsWith("\n") || atual === "" ? "" : "\n"}${linha}\n`;
  fs.writeFileSync(perfil, novo);
  // O perfil passa a guardar um token de ADMINISTRADOR: só o dono lê. (O `mode` do
  // writeFileSync só vale na criação; um perfil que já existia mantinha 644.)
  fs.chmodSync(perfil, 0o600);
  return perfil;
}

async function main(): Promise<void> {
  const cliente = (argumento("cliente") ?? "claude") as ClienteDeAssistente;
  const assistente = ASSISTENTES[cliente];
  if (!assistente) falhar(`Assistente desconhecido: ${cliente}. Use claude ou codex.`);

  try {
    execFileSync(assistente.programa, ["--version"], { stdio: "ignore" });
  } catch {
    falhar(`${assistente.nome} não encontrado. Instale (${assistente.instalar}) e rode de novo.`);
  }

  const urlDaInstalacao = argumento("url") ?? process.env.NEXT_PUBLIC_APP_URL;
  if (!urlDaInstalacao) {
    falhar(`Informe a URL do CRM: pnpm conectar-${cliente} --url https://crm.suaempresa.com.br`);
  }
  let endereco: string;
  try {
    endereco = urlDoMcp(urlDaInstalacao);
  } catch (e) {
    falhar((e as Error).message);
  }
  const nome = argumento("nome") ?? NOME_DO_SERVIDOR_MCP;

  console.info(
    `\nConectar o ${assistente.nome} a ${endereco} (nome no ${assistente.nome}: "${nome}").`,
  );
  console.info(
    "Cole o token criado em Configurações › API Tokens › Criar token para o assistente.",
  );
  const token = await perguntarOculto("Token (não aparece enquanto você digita): ");
  if (!tokenTemFormatoValido(token)) {
    falhar("Isso não é um token do CRM (começa com dsk_). Confira se copiou o token inteiro.");
  }

  await provarToken(endereco, token);
  console.info("✔ O CRM aceitou o token.");

  const args =
    cliente === "claude"
      ? argumentosDoClaudeMcpAdd({ urlDaInstalacao, token, nome })
      : argumentosDoCodexMcpAdd({ urlDaInstalacao, nome });
  try {
    execFileSync(assistente.programa, args, { stdio: "pipe" });
  } catch (e) {
    const detalhe = String((e as { stderr?: Buffer }).stderr ?? "").replace(
      /dsk_[A-Za-z0-9_-]+/g,
      "dsk_***",
    );
    if (/already exists/i.test(detalhe)) {
      falhar(
        `Já existe um servidor "${nome}" no ${assistente.nome}. Remova com: ${assistente.programa} mcp remove ${nome}${cliente === "claude" ? " -s user" : ""}`,
      );
    }
    falhar(
      `O ${assistente.nome} não aceitou a configuração: ${detalhe.trim() || "erro desconhecido"}`,
    );
  }

  if (cliente === "codex") {
    const perfil = gravarTokenNoPerfil(token);
    console.info(
      `✔ Token guardado em ${perfil} (${VARIAVEL_DO_TOKEN_NO_CODEX}). Abra um terminal novo.`,
    );
  }
  console.info(
    `✔ Pronto. Abra o ${assistente.nome} e peça, por exemplo: "liste os negócios que esfriaram esta semana".`,
  );
  console.info(
    `  Para desconectar: ${assistente.programa} mcp remove ${nome}${cliente === "claude" ? " -s user" : ""} — e revogue o token na tela.\n`,
  );
}

void main();
