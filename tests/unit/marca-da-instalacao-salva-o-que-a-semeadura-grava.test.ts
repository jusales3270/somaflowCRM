import { describe, expect, it } from "vitest";

import { DEFAULT_LOGO_URL } from "@/lib/branding";
import { platformBrandingSchema } from "@/lib/schemas/settings";

/**
 * O que a semeadura grava, o formulário de Admin › Marca precisa conseguir devolver.
 *
 * POR QUE EXISTE: o `.env.example` desta distribuição traz `APP_LOGO_URL="/logo.png"`,
 * a instalação é semeada com esse caminho relativo, e o formulário devolve o
 * `logo_url` gravado COMO ESTÁ ao salvar. O schema exigia URL absoluta, então o
 * revendedor via "Confira os campos: algum valor não está no formato esperado" ao
 * trocar só o nome — sem dizer qual campo — e a tela de marca (o produto da
 * revenda) ficava inutilizável. Medido no navegador em 03/10/2026.
 */

const BASE = { app_name: "Revenda Teste CRM", accent_hex: "#7a5cd6", show_powered_by: true };

describe("platformBrandingSchema.logo_url", () => {
  it("devolve o logo padrão semeado (caminho do próprio servidor) sem recusar", () => {
    const r = platformBrandingSchema.safeParse({ ...BASE, logo_url: DEFAULT_LOGO_URL });
    expect(r.success, JSON.stringify(r.success ? "" : r.error.issues)).toBe(true);
  });

  it("continua aceitando URL absoluta e null (apagar o logo)", () => {
    expect(platformBrandingSchema.safeParse({ ...BASE, logo_url: "https://cdn.acme.test/l.svg" }).success).toBe(true);
    expect(platformBrandingSchema.safeParse({ ...BASE, logo_url: null }).success).toBe(true);
  });

  it.each([
    ["URL relativa ao protocolo (sairia do servidor)", "//evil.test/x.png"],
    ["barra invertida (o navegador a trata como //)", "/\\evil.test/x.png"],
    ["caminho sem barra inicial", "logo.png"],
    ["caminho com espaço", "/meu logo.png"],
    ["vazio", ""],
  ])("recusa %s", (_nome, valor) => {
    expect(platformBrandingSchema.safeParse({ ...BASE, logo_url: valor }).success).toBe(false);
  });
});
