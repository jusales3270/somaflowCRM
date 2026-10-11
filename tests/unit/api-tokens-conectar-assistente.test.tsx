import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Configurações › API Tokens › "Conectar seu assistente de IA".
 *
 * O dono da instalação conecta o assistente DELE — Claude Code (assinatura do Claude)
 * ou Codex (assinatura do ChatGPT) — ao MCP do CRM, e escolhe qual. O admin de uma
 * organização de revenda não vê o atalho: para ela seguem os tokens de integração e a
 * chave de API dos agentes. Nenhuma assinatura entra no CRM: a tela cria um token
 * `dsk_` e mostra os comandos que o usam.
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

async function tela(conectarAssistente: { urlDaInstalacao: string } | null) {
  const { ApiTokensClient } =
    await import("@/app/app/settings/api-tokens/_components/ApiTokensClient");
  return render(<ApiTokensClient conectarAssistente={conectarAssistente} />);
}

const CRIADO = {
  data: {
    id: "t1",
    name: "Assistente de IA (administração)",
    prefix: "dsk_0a1b2c3d",
    scopes: ["mcp:read", "mcp:write", "role:admin"],
    plaintext: TOKEN,
    _warning: "Salve este token agora",
  },
};

describe("Conectar seu assistente de IA", () => {
  it("admin de organização (sem ser da instalação) NÃO vê o atalho", async () => {
    await tela(null);
    expect(screen.queryByTestId("conectar-assistente")).toBeNull();
    expect(screen.getByText("Criar token")).toBeTruthy();
  });

  it("admin da instalação cria o token com escopos e validade certos e recebe o comando do Claude Code", async () => {
    criar.mockResolvedValue(CRIADO);
    await tela({ urlDaInstalacao: "https://crm.acme.test" });

    fireEvent.click(screen.getByText("Criar token para o assistente"));

    await waitFor(() => expect(screen.getByTestId("comandos-do-assistente")).toBeTruthy());
    expect(criar).toHaveBeenCalledWith({
      name: "Assistente de IA (administração)",
      scopes: ["mcp:read", "mcp:write", "role:admin"],
      expires_in_days: 90,
    });
    expect(screen.getByTestId("comando-claude-code").textContent).toBe(
      `claude mcp add --scope user --transport http crm https://crm.acme.test/api/mcp --header "Authorization: Bearer ${TOKEN}"`,
    );
  });

  it("escolhendo o Codex, mostra os dois comandos: guardar o token e conectar (sem token na config)", async () => {
    criar.mockResolvedValue(CRIADO);
    await tela({ urlDaInstalacao: "https://crm.acme.test" });

    fireEvent.click(screen.getByText("Criar token para o assistente"));
    await waitFor(() => expect(screen.getByTestId("comandos-do-assistente")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));

    expect(screen.queryByTestId("comando-claude-code")).toBeNull();
    expect(screen.getByTestId("comando-codex-token").textContent).toBe(
      `echo 'export CRM_MCP_TOKEN="${TOKEN}"' >> ~/.zshrc && source ~/.zshrc`,
    );
    expect(screen.getByTestId("comando-codex").textContent).toBe(
      "codex mcp add crm --url https://crm.acme.test/api/mcp --bearer-token-env-var CRM_MCP_TOKEN",
    );
  });

  it("um token comum de integração NÃO ganha os comandos do assistente", async () => {
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
    expect(screen.queryByTestId("comandos-do-assistente")).toBeNull();
  });
});
