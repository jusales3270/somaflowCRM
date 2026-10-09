import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Configurações › API Tokens › "Conectar ao Claude Code".
 *
 * O dono da instalação conecta o Claude Code DELE (com a assinatura dele) ao MCP do
 * CRM; o admin de uma organização de revenda não vê o atalho — para ela seguem os
 * tokens de integração e a chave de API dos agentes. A assinatura nunca entra no CRM:
 * o que a tela cria é um token `dsk_` e o comando `claude mcp add` que o usa.
 */

const TOKEN = "dsk_0a1b2c3d_" + "A".repeat(43);
const criar = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/team/useApiTokens", () => ({
  useApiTokens: () => ({ data: { data: [] }, isLoading: false }),
  useCreateApiToken: () => ({ mutateAsync: criar, isPending: false }),
  useRevokeApiToken: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

afterEach(() => {
  cleanup();
  criar.mockReset();
});

async function tela(conectarClaudeCode: { urlDaInstalacao: string } | null) {
  const { ApiTokensClient } =
    await import("@/app/app/settings/api-tokens/_components/ApiTokensClient");
  return render(<ApiTokensClient conectarClaudeCode={conectarClaudeCode} />);
}

describe("Conectar ao Claude Code", () => {
  it("admin de organização (sem ser da instalação) NÃO vê o atalho", async () => {
    await tela(null);
    expect(screen.queryByTestId("conectar-claude-code")).toBeNull();
    expect(screen.getByText("Criar token")).toBeTruthy();
  });

  it("admin da instalação cria o token com os escopos e a validade certos, e recebe o comando pronto", async () => {
    criar.mockResolvedValue({
      data: {
        id: "t1",
        name: "Claude Code (administração)",
        prefix: "dsk_0a1b2c3d",
        scopes: ["mcp:read", "mcp:write", "role:admin"],
        plaintext: TOKEN,
        _warning: "Salve este token agora",
      },
    });
    await tela({ urlDaInstalacao: "https://crm.acme.test" });

    fireEvent.click(screen.getByText("Criar token para o Claude Code"));

    await waitFor(() => expect(screen.getByTestId("comando-claude-code")).toBeTruthy());
    expect(criar).toHaveBeenCalledWith({
      name: "Claude Code (administração)",
      scopes: ["mcp:read", "mcp:write", "role:admin"],
      expires_in_days: 90,
    });
    expect(screen.getByTestId("comando-claude-code").textContent).toContain(
      `claude mcp add --scope user --transport http crm https://crm.acme.test/api/mcp --header "Authorization: Bearer ${TOKEN}"`,
    );
  });

  it("um token comum de integração NÃO ganha o comando do Claude Code", async () => {
    criar.mockResolvedValue({
      data: {
        id: "t2",
        name: "ERP",
        prefix: "dsk_x",
        scopes: ["leads:read"],
        plaintext: TOKEN,
        _warning: "",
      },
    });
    await tela({ urlDaInstalacao: "https://crm.acme.test" });

    fireEvent.click(screen.getByText("Criar token"));
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "ERP" } });
    fireEvent.click(screen.getByRole("button", { name: /leads:read/ }));
    fireEvent.click(screen.getByRole("button", { name: "Criar" }));

    await waitFor(() => expect(screen.getByText("Token criado")).toBeTruthy());
    expect(screen.queryByTestId("comando-claude-code")).toBeNull();
  });
});
