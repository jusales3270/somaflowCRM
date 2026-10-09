/**
 * `pnpm conectar-claude` — conecta o Claude Code de quem administra a instalação ao
 * servidor MCP do CRM.
 *
 * O token `dsk_` é criado em Configurações › API Tokens › "Criar token para o Claude
 * Code" (só administrador da instalação). Este script:
 *
 *   1. confere que o Claude Code está instalado;
 *   2. pede o token num prompt OCULTO — nunca por argumento, que iria para o
 *      histórico do shell e para a lista de processos;
 *   3. prova que o token funciona chamando `initialize` no `/api/mcp`;
 *   4. só então roda `claude mcp add` (escopo de usuário), sem shell no meio.
 *
 * A assinatura do Claude nunca passa por aqui: ela fica no Claude Code, e é ele quem
 * fala com a Anthropic. Ver `lib/mcp/conectar-claude-code.ts`.
 *
 * Uso: pnpm conectar-claude [--url https://crm.suaempresa.com.br] [--nome crm]
 */
import { execFileSync } from "node:child_process";
import * as readline from "node:readline";

import {
  argumentosDoClaudeMcpAdd,
  NOME_DO_SERVIDOR_MCP,
  tokenTemFormatoValido,
  urlDoMcp,
} from "@/lib/mcp/conectar-claude-code";

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
    // Terminal de verdade: sem eco. Entrada canalizada (`echo dsk_… | pnpm conectar-claude`):
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
          clientInfo: { name: "conectar-claude", version: "1" },
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

async function main(): Promise<void> {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
  } catch {
    falhar("Claude Code não encontrado. Instale em https://claude.com/claude-code e rode de novo.");
  }

  const urlDaInstalacao = argumento("url") ?? process.env.NEXT_PUBLIC_APP_URL;
  if (!urlDaInstalacao) {
    falhar("Informe a URL do CRM: pnpm conectar-claude --url https://crm.suaempresa.com.br");
  }
  let endereco: string;
  try {
    endereco = urlDoMcp(urlDaInstalacao);
  } catch (e) {
    falhar((e as Error).message);
  }
  const nome = argumento("nome") ?? NOME_DO_SERVIDOR_MCP;

  console.info(`\nConectar o Claude Code a ${endereco} (nome no Claude Code: "${nome}").`);
  console.info(
    "Cole o token criado em Configurações › API Tokens › Criar token para o Claude Code.",
  );
  const token = await perguntarOculto("Token (não aparece enquanto você digita): ");
  if (!tokenTemFormatoValido(token)) {
    falhar("Isso não é um token do CRM (começa com dsk_). Confira se copiou o token inteiro.");
  }

  await provarToken(endereco, token);
  console.info("✔ O CRM aceitou o token.");

  try {
    execFileSync("claude", argumentosDoClaudeMcpAdd({ urlDaInstalacao, token, nome }), {
      stdio: "pipe",
    });
  } catch (e) {
    const detalhe = String((e as { stderr?: Buffer }).stderr ?? "").replace(
      /dsk_[A-Za-z0-9_-]+/g,
      "dsk_***",
    );
    if (/already exists/i.test(detalhe)) {
      falhar(
        `Já existe um servidor "${nome}" no Claude Code. Remova com: claude mcp remove ${nome} -s user`,
      );
    }
    falhar(`O Claude Code não aceitou a configuração: ${detalhe.trim() || "erro desconhecido"}`);
  }

  console.info(
    `✔ Pronto. Abra o Claude Code e peça, por exemplo: "liste os negócios que esfriaram esta semana".`,
  );
  console.info(
    `  Para desconectar: claude mcp remove ${nome} -s user — e revogue o token na tela.\n`,
  );
}

void main();
