import { describe, expect, it, vi } from "vitest";

import { guardarCotacoes } from "@/app/api/v1/cron/cotacao-do-dolar/route";

function adminFalso(erro: { message: string } | null = null) {
  const upsert = vi.fn(async () => ({ error: erro }));
  const from = vi.fn(() => ({ upsert }));
  return { admin: { from } as never, from, upsert };
}

const AGORA = new Date("2026-10-11T19:40:00Z");

describe("cron cotacao-do-dolar", () => {
  it("pede os últimos 10 dias de Brasília e grava uma linha por dia, por upsert", async () => {
    const { admin, from, upsert } = adminFalso();
    const buscar = vi.fn(async () => [
      { data: "2026-10-08", venda: 5.0119, compra: 5.0113 },
      { data: "2026-10-09", venda: 4.9892, compra: 4.9886 },
    ]);

    const r = await guardarCotacoes(admin, buscar, AGORA);

    expect(buscar).toHaveBeenCalledWith("2026-10-01", "2026-10-11");
    expect(from).toHaveBeenCalledWith("cotacoes_do_dolar");
    expect(upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({ data: "2026-10-08", venda: 5.0119, compra: 5.0113, fonte: "bcb_ptax" }),
        expect.objectContaining({ data: "2026-10-09", venda: 4.9892, compra: 4.9886, fonte: "bcb_ptax" }),
      ],
      { onConflict: "data" },
    );
    expect(r).toEqual({ recebidas: 2, mais_recente: { data: "2026-10-09", venda: 4.9892, compra: 4.9886 } });
  });

  it("período sem cotação (feriadão) não grava nada e não falha", async () => {
    const { admin, upsert } = adminFalso();
    const r = await guardarCotacoes(admin, async () => [], AGORA);
    expect(upsert).not.toHaveBeenCalled();
    expect(r).toEqual({ recebidas: 0, mais_recente: null });
  });

  it("falha ao gravar sobe como erro — o handler responde 500 e o scheduler registra", async () => {
    const { admin } = adminFalso({ message: "permission denied" });
    await expect(
      guardarCotacoes(admin, async () => [{ data: "2026-10-09", venda: 4.9892, compra: 4.9886 }], AGORA),
    ).rejects.toThrow("cotacao_upsert_falhou: permission denied");
  });
});
