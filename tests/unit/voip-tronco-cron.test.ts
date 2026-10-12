import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auditado = vi.hoisted(() => ({ acoes: [] as string[] }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: { action: string }) => {
    auditado.acoes.push(e.action);
  }),
}));

const tronco = vi.hoisted(() => ({
  presentes: new Set<string>(),
  aplicados: [] as string[],
  removidos: [] as string[],
  alcancavel: true,
}));
vi.mock("@/lib/voip/tronco-no-asterisk", async (original) => ({
  ...(await original<typeof import("@/lib/voip/tronco-no-asterisk")>()),
  asteriskAlcancavel: vi.fn(async () => tronco.alcancavel),
  troncoPresente: vi.fn(async (orgId: string) => tronco.presentes.has(orgId)),
  aplicarTronco: vi.fn(async (d: { orgId: string }) => {
    tronco.aplicados.push(d.orgId);
    return { ok: true };
  }),
  removerTronco: vi.fn(async (orgId: string) => {
    tronco.removidos.push(orgId);
    return { ok: true };
  }),
}));
vi.mock("@/lib/voip/tronco-da-organizacao", () => ({
  lerTronco: vi.fn(async (_admin: unknown, orgId: string) => ({
    ativo: true,
    dados: { orgId, host: "h", port: 5060, username: "u", password: "p", fromDomain: null },
  })),
}));

import { reconciliarTroncos } from "@/app/api/v1/cron/voip-tronco/route";

function adminCom(linhas: Array<{ organization_id: string; is_active: boolean }>) {
  return { from: () => ({ select: async () => ({ data: linhas, error: null }) }) } as never;
}

const ENV = { ...process.env };
beforeEach(() => {
  process.env.ARI_URL = "http://asterisk:8088";
  process.env.ARI_USERNAME = "u";
  process.env.ARI_PASSWORD = "p";
  auditado.acoes = [];
  tronco.presentes = new Set();
  tronco.aplicados = [];
  tronco.removidos = [];
  tronco.alcancavel = true;
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("cron voip-tronco", () => {
  it("sem telefonia na instalação, não lê nada nem audita", async () => {
    delete process.env.ARI_URL;
    const r = await reconciliarTroncos(adminCom([{ organization_id: "a", is_active: true }]), "req");
    expect(r).toMatchObject({ sem_telefonia: true, aplicados: 0 });
    expect(auditado.acoes).toEqual([]);
  });

  it("aplica o ativo que sumiu, remove o desativado que ficou, e não mexe no que já está certo", async () => {
    tronco.presentes = new Set(["ja-esta", "desativado"]);
    const r = await reconciliarTroncos(
      adminCom([
        { organization_id: "sumiu", is_active: true },
        { organization_id: "ja-esta", is_active: true },
        { organization_id: "desativado", is_active: false },
        { organization_id: "desativado-ausente", is_active: false },
      ]),
      "req",
    );
    expect(tronco.aplicados).toEqual(["sumiu"]);
    expect(tronco.removidos).toEqual(["desativado"]);
    expect(r).toMatchObject({ troncos: 4, aplicados: 1, removidos: 1, falhas: 0 });
    // Só a rodada que mudou o Asterisk audita — uma linha por organização.
    expect(auditado.acoes).toEqual(["voip_trunk.aplicado_no_asterisk", "voip_trunk.removido_do_asterisk"]);
  });

  it("Asterisk fora: não tenta aplicar nada e não audita", async () => {
    tronco.alcancavel = false;
    const r = await reconciliarTroncos(adminCom([{ organization_id: "a", is_active: true }]), "req");
    expect(r).toMatchObject({ asterisk_fora: true, aplicados: 0 });
    expect(auditado.acoes).toEqual([]);
  });
});
