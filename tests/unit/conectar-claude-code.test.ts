import { describe, expect, it } from "vitest";

import {
  argumentosDoClaudeMcpAdd,
  comandoDoClaudeMcpAdd,
  ESCOPOS_DO_CLAUDE_CODE,
  tokenTemFormatoValido,
  urlDoMcp,
} from "@/lib/mcp/conectar-claude-code";

const TOKEN = "dsk_0a1b2c3d_" + "A".repeat(43);

describe("conectar o Claude Code ao MCP do CRM", () => {
  it("os escopos liberam ler e agir no CRM com papel de admin — e nada de credencial de assinatura", () => {
    expect([...ESCOPOS_DO_CLAUDE_CODE]).toEqual(["mcp:read", "mcp:write", "role:admin"]);
  });

  it("o endereço do MCP sai da URL pública, com ou sem barra final", () => {
    expect(urlDoMcp("https://crm.acme.test")).toBe("https://crm.acme.test/api/mcp");
    expect(urlDoMcp("https://crm.acme.test/")).toBe("https://crm.acme.test/api/mcp");
    expect(urlDoMcp("http://localhost:3003")).toBe("http://localhost:3003/api/mcp");
  });

  it("recusa URL que o Claude Code não alcança", () => {
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

  it("monta os argumentos do `claude mcp add` em escopo de usuário, por HTTP, com o Bearer no cabeçalho", () => {
    expect(
      argumentosDoClaudeMcpAdd({ urlDaInstalacao: "https://crm.acme.test", token: TOKEN }),
    ).toEqual([
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
    expect(comandoDoClaudeMcpAdd({ urlDaInstalacao: "https://crm.acme.test", token: TOKEN })).toBe(
      `claude mcp add --scope user --transport http crm https://crm.acme.test/api/mcp --header "Authorization: Bearer ${TOKEN}"`,
    );
  });

  it("nunca põe o token na URL — só no cabeçalho", () => {
    const args = argumentosDoClaudeMcpAdd({
      urlDaInstalacao: "https://crm.acme.test",
      token: TOKEN,
    });
    expect(args.filter((a) => a.includes(TOKEN))).toEqual([`Authorization: Bearer ${TOKEN}`]);
  });
});
