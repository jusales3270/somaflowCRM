import { describe, expect, it } from "vitest";

import {
  argumentosDoClaudeMcpAdd,
  argumentosDoCodexMcpAdd,
  comandoDoClaudeMcpAdd,
  comandosDoCodex,
  ESCOPOS_DO_ASSISTENTE,
  tokenTemFormatoValido,
  urlDoMcp,
  VARIAVEL_DO_TOKEN_NO_CODEX,
} from "@/lib/mcp/conectar-assistente";

const TOKEN = "dsk_0a1b2c3d_" + "A".repeat(43);
const URL_DA_INSTALACAO = "https://crm.acme.test";

describe("conectar o assistente de IA (Claude Code ou Codex) ao MCP do CRM", () => {
  it("os escopos liberam ler e agir no CRM com papel de admin — e nada de credencial de assinatura", () => {
    expect([...ESCOPOS_DO_ASSISTENTE]).toEqual(["mcp:read", "mcp:write", "role:admin"]);
  });

  it("o endereço do MCP sai da URL pública, com ou sem barra final", () => {
    expect(urlDoMcp("https://crm.acme.test")).toBe("https://crm.acme.test/api/mcp");
    expect(urlDoMcp("https://crm.acme.test/")).toBe("https://crm.acme.test/api/mcp");
    expect(urlDoMcp("http://localhost:3003")).toBe("http://localhost:3003/api/mcp");
  });

  it("recusa URL que o assistente não alcança", () => {
    expect(() => urlDoMcp("ftp://crm.acme.test")).toThrow(/http/);
    expect(() => urlDoMcp("não é url")).toThrow();
  });

  it("valida o formato do token que a rota de API Tokens emite", () => {
    expect(tokenTemFormatoValido(TOKEN)).toBe(true);
    expect(tokenTemFormatoValido(`  ${TOKEN}\n`)).toBe(true);
    expect(tokenTemFormatoValido("sk-ant-api03-xyz")).toBe(false);
    expect(tokenTemFormatoValido("dsk_semhex_abc")).toBe(false);
    expect(tokenTemFormatoValido("")).toBe(false);
  });
});

describe("Claude Code", () => {
  it("monta o `claude mcp add` em escopo de usuário, por HTTP, com o Bearer no cabeçalho", () => {
    expect(argumentosDoClaudeMcpAdd({ urlDaInstalacao: URL_DA_INSTALACAO, token: TOKEN })).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "http",
      "crm",
      "https://crm.acme.test/api/mcp",
      "--header",
      `Authorization: Bearer ${TOKEN}`,
    ]);
  });

  it("o comando de texto põe aspas no cabeçalho (tem espaço) e em nada mais", () => {
    expect(comandoDoClaudeMcpAdd({ urlDaInstalacao: URL_DA_INSTALACAO, token: TOKEN })).toBe(
      `claude mcp add --scope user --transport http crm https://crm.acme.test/api/mcp --header "Authorization: Bearer ${TOKEN}"`,
    );
  });

  it("nunca põe o token na URL — só no cabeçalho", () => {
    const args = argumentosDoClaudeMcpAdd({ urlDaInstalacao: URL_DA_INSTALACAO, token: TOKEN });
    expect(args.filter((a) => a.includes(TOKEN))).toEqual([`Authorization: Bearer ${TOKEN}`]);
  });
});

describe("Codex", () => {
  it("monta o `codex mcp add` por URL e SEM o token — ele lê o token da variável de ambiente", () => {
    const args = argumentosDoCodexMcpAdd({ urlDaInstalacao: URL_DA_INSTALACAO });
    expect(args).toEqual([
      "mcp",
      "add",
      "crm",
      "--url",
      "https://crm.acme.test/api/mcp",
      "--bearer-token-env-var",
      VARIAVEL_DO_TOKEN_NO_CODEX,
    ]);
    expect(args.join(" ")).not.toContain("dsk_");
  });

  it("os comandos para colar: guardar o token no perfil do shell e depois conectar", () => {
    const [guardar, conectar] = comandosDoCodex({
      urlDaInstalacao: URL_DA_INSTALACAO,
      token: TOKEN,
    });
    expect(guardar).toBe(`echo 'export CRM_MCP_TOKEN="${TOKEN}"' >> ~/.zshrc && source ~/.zshrc`);
    expect(conectar).toBe(
      "codex mcp add crm --url https://crm.acme.test/api/mcp --bearer-token-env-var CRM_MCP_TOKEN",
    );
  });
});
