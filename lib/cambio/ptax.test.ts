import { describe, expect, it, vi } from "vitest";

import { buscarPtaxDoPeriodo, diaEmBrasilia, traduzirRespostaPtax, urlDoPeriodo } from "./ptax";

/** Formato real do OData do BCB (resposta de 11/10/2026, encurtada). */
const RESPOSTA_DO_BCB = {
  "@odata.context": "https://was-p.bcnet.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata$metadata",
  value: [
    { cotacaoCompra: 5.0113, cotacaoVenda: 5.0119, dataHoraCotacao: "2026-10-08 13:08:16.814037" },
    { cotacaoCompra: 4.9886, cotacaoVenda: 4.9892, dataHoraCotacao: "2026-10-09 13:07:30.746597" },
  ],
};

describe("PTAX do Banco Central", () => {
  it("traduz a resposta em uma cotação por dia, em ordem", () => {
    expect(traduzirRespostaPtax(RESPOSTA_DO_BCB)).toEqual([
      { data: "2026-10-08", venda: 5.0119, compra: 5.0113 },
      { data: "2026-10-09", venda: 4.9892, compra: 4.9886 },
    ]);
  });

  it("descarta linha fora do formato — cotação zero converteria a conta em R$ 0,00", () => {
    const r = traduzirRespostaPtax({
      value: [
        { cotacaoCompra: 0, cotacaoVenda: 0, dataHoraCotacao: "2026-10-08 13:00:00" },
        { cotacaoCompra: "5", cotacaoVenda: "5", dataHoraCotacao: "2026-10-08 13:00:00" },
        { cotacaoCompra: 5, cotacaoVenda: 5, dataHoraCotacao: "ontem" },
        { cotacaoCompra: 4.98, cotacaoVenda: 4.99, dataHoraCotacao: "2026-10-09 13:00:00" },
      ],
    });
    expect(r).toEqual([{ data: "2026-10-09", venda: 4.99, compra: 4.98 }]);
  });

  it("resposta sem `value` é erro, não lista vazia (não esconde a origem quebrada)", () => {
    expect(() => traduzirRespostaPtax({ erro: "x" })).toThrow(/ptax_formato_inesperado/);
    expect(() => traduzirRespostaPtax(null)).toThrow(/ptax_formato_inesperado/);
  });

  it("monta o período no formato MM-DD-AAAA que o OData exige", () => {
    const url = decodeURIComponent(urlDoPeriodo("2026-10-01", "2026-10-11"));
    expect(url).toContain("CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)");
    expect(url).toContain("@dataInicial='10-01-2026'");
    expect(url).toContain("@dataFinalCotacao='10-11-2026'");
    expect(url).toContain("$format=json");
  });

  it("o dia é o de Brasília: 01h UTC ainda é o dia anterior lá", () => {
    expect(diaEmBrasilia(new Date("2026-10-12T01:00:00Z"))).toBe("2026-10-11");
    expect(diaEmBrasilia(new Date("2026-10-12T15:00:00Z"))).toBe("2026-10-12");
    expect(diaEmBrasilia(new Date("2026-10-12T15:00:00Z"), 10)).toBe("2026-10-02");
  });

  it("status de erro do BCB vira exceção com o código", async () => {
    const buscar = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("fora", { status: 503 }));
    await expect(buscarPtaxDoPeriodo("2026-10-01", "2026-10-11", buscar)).rejects.toThrow("ptax_status_503");
  });

  it("busca e traduz", async () => {
    const buscar = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(RESPOSTA_DO_BCB));
    const r = await buscarPtaxDoPeriodo("2026-10-01", "2026-10-11", buscar);
    expect(r.at(-1)).toEqual({ data: "2026-10-09", venda: 4.9892, compra: 4.9886 });
    expect(String(buscar.mock.calls[0]?.[0])).toContain("olinda.bcb.gov.br");
  });
});
