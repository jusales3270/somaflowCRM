import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MarcaDeSaida } from "@/lib/branding/saida";

/**
 * O subtítulo sob o "Entrar" é o nome da marca RESOLVIDA (banco acima do `.env`).
 *
 * POR QUE EXISTE: ele vinha de `branding().name`, que lê só o `.env`. Quem trocava o
 * nome em Admin › Marca via o título da aba mudar (banco) e o login seguir com o nome
 * antigo (`.env`) — medido no navegador em 03/10/2026, e o mesmo em cadastro, termos
 * legais e onboarding. O resto das telas é vigiado pela catraca de
 * `marca-sem-divergencia-de-hidratacao.test.tsx`; este teste EXECUTA a do login.
 */

const marcaDaSaida = vi.hoisted(() => vi.fn());
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  })),
}));
vi.mock("@/lib/i18n/idiomaAnonimo", () => ({ idiomaDoVisitante: vi.fn(async () => "pt-BR") }));
vi.mock("@/components/auth/LoginForm", () => ({ LoginForm: () => <form data-testid="form" /> }));
vi.mock("@/components/auth/EntrarComGoogle", () => ({ EntrarComGoogle: () => null }));

const MARCA: MarcaDeSaida = {
  nome: "Revenda Teste CRM",
  logoUrl: null,
  accent: "#7a5cd6",
  accentFg: "#ffffff",
  origens: { nome: "banco", cor: "banco" },
};

describe("a tela de login", () => {
  beforeEach(() => {
    vi.resetModules();
    marcaDaSaida.mockReset();
  });

  it("mostra o nome da marca resolvida — nunca o nome padrão do produto", async () => {
    marcaDaSaida.mockResolvedValue(MARCA);
    const { default: LoginPage } = await import("@/app/(public)/login/page");
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Revenda Teste CRM");
    expect(html).not.toContain("SomaFlow CRM");
    expect(marcaDaSaida).toHaveBeenCalledWith(null);
  });
});
