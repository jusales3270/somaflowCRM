import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { guardarTrunk } from "@/lib/voip/guardar-trunk";

/**
 * "Deixe em branco para manter a atual" — a frase da própria tela — dava 500.
 * As colunas de senha são NOT NULL e a gravação era um upsert: o INSERT do
 * `ON CONFLICT DO UPDATE` saía sem senha e o Postgres recusava. Medido na tela
 * (desligar o tronco sem redigitar a senha → HTTP 500). Atualizar tem de ser
 * UPDATE, sem tocar nas colunas de senha.
 */
function adminFalso(existe: boolean) {
  const chamadas: Array<{ op: string; valores?: Record<string, unknown>; filtro?: [string, unknown] }> = [];
  const admin = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: existe ? { organization_id: "org" } : null, error: null }) }),
      }),
      update: (valores: Record<string, unknown>) => ({
        eq: async (coluna: string, valor: unknown) => {
          chamadas.push({ op: "update", valores, filtro: [coluna, valor] });
          return { error: null };
        },
      }),
      insert: async (valores: Record<string, unknown>) => {
        chamadas.push({ op: "insert", valores });
        return { error: null };
      },
      upsert: async () => {
        chamadas.push({ op: "upsert" });
        return { error: { message: 'null value in column "password_encrypted" violates not-null constraint' } };
      },
    }),
  };
  return { admin: admin as never, chamadas };
}

const PEDIDO = {
  orgId: "org",
  userId: "user",
  host: "sip.provedor.test",
  port: 5060,
  username: "1001",
  fromDomain: null,
  isActive: false,
};

describe("guardar o tronco sem redigitar a senha", () => {
  it("atualiza a linha existente — sem upsert e sem tocar nas colunas de senha", async () => {
    const { admin, chamadas } = adminFalso(true);
    expect(await guardarTrunk({ admin, ...PEDIDO })).toEqual({ ok: true });
    expect(chamadas.map((c) => c.op)).toEqual(["update"]);
    expect(chamadas[0]!.filtro).toEqual(["organization_id", "org"]);
    expect(Object.keys(chamadas[0]!.valores!).filter((k) => k.startsWith("password"))).toEqual([]);
    expect(chamadas[0]!.valores).toMatchObject({ is_active: false, endpoint_name: "org-org-trunk-endpoint" });
  });

  it("na primeira vez a senha continua obrigatória", async () => {
    const { admin, chamadas } = adminFalso(false);
    expect(await guardarTrunk({ admin, ...PEDIDO })).toEqual({ ok: false, motivo: "senha_obrigatoria_na_criacao" });
    expect(chamadas).toEqual([]);
  });
});
