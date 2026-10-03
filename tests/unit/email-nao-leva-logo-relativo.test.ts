import { describe, expect, it } from "vitest";

import { DEFAULT_LOGO_URL } from "@/lib/branding";
import { logoParaEmail, type MarcaDeSaida } from "@/lib/branding/saida";
import { buildInviteEmail } from "@/lib/email/templates/invite";
import { montarTemplateDeAcesso } from "@/lib/email/templates/acesso-gotrue";

/**
 * O e-mail é aberto fora do app: um caminho do próprio servidor não resolve em lugar
 * nenhum e vira o ícone de imagem quebrada no topo do primeiro e-mail que a pessoa
 * recebe do sistema.
 *
 * POR QUE EXISTE: o logo padrão desta distribuição é `/logo.png` (relativo, serve o
 * app e a barra lateral). Depois que o resolvedor passou a devolvê-lo também para a
 * marca padrão, os dois templates (convite e acesso) o colocariam num `<img src="/logo.png">`.
 */

const MARCA: MarcaDeSaida = {
  nome: "Revenda Teste CRM",
  logoUrl: null,
  accent: "#7a5cd6",
  accentFg: "#ffffff",
  origens: { nome: "banco", cor: "banco" },
};

const convite = (marca: MarcaDeSaida) =>
  buildInviteEmail({
    inviterName: "Ana",
    orgName: "Loja",
    acceptUrl: "https://crm.exemplo.test/aceitar?t=1",
    role: "agent",
    expiresAt: new Date("2026-12-31T00:00:00Z"),
    marca,
  }).html;

describe("logoParaEmail", () => {
  it("só URL absoluta http(s) serve a um e-mail", () => {
    expect(logoParaEmail("https://cdn.acme.test/l.png")).toBe("https://cdn.acme.test/l.png");
    expect(logoParaEmail("http://cdn.acme.test/l.png")).toBe("http://cdn.acme.test/l.png");
    expect(logoParaEmail(DEFAULT_LOGO_URL)).toBeNull();
    expect(logoParaEmail("/qualquer/caminho.png")).toBeNull();
    expect(logoParaEmail(null)).toBeNull();
  });
});

describe("os e-mails com a marca padrão (logo relativo)", () => {
  const padrao = { ...MARCA, logoUrl: DEFAULT_LOGO_URL };

  it("convite: sem <img> — o nome em texto já está lá", () => {
    const html = convite(padrao);
    expect(html).not.toContain("<img");
    expect(html).toContain("Revenda Teste CRM");
  });

  it("acesso (confirmação/recuperação): sem <img>", () => {
    expect(montarTemplateDeAcesso("confirmation", padrao)).not.toContain("<img");
    expect(montarTemplateDeAcesso("recovery", padrao)).not.toContain("<img");
  });
});

describe("os e-mails com logo absoluto", () => {
  const comLogo = { ...MARCA, logoUrl: "https://cdn.acme.test/l.png" };

  it("convite e acesso levam o <img>", () => {
    expect(convite(comLogo)).toContain('<img src="https://cdn.acme.test/l.png"');
    expect(montarTemplateDeAcesso("confirmation", comLogo)).toContain(
      '<img src="https://cdn.acme.test/l.png"',
    );
  });
});
