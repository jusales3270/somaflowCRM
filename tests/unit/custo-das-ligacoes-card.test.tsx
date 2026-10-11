import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CustoDasLigacoesCard } from "@/components/ai/CustoDasLigacoesCard";
import {
  custoDasLigacoesSchema,
  mediasDasLigacoes,
  type CustoDasLigacoes,
} from "@/lib/ai/usage/custo-das-ligacoes";

/** O que `fn_custo_das_ligacoes` devolve — numeric do Postgres pode vir como texto. */
const DO_BANCO = {
  totais: {
    ligacoes: 2,
    falhas: 1,
    duracao_ms: 900_000,
    custo_usd_cents: "60",
    custo_brl_cents: "299.352",
    sem_preco: 0,
    sem_cotacao: 0,
  },
  recentes: [
    {
      created_at: "2026-10-09T18:00:00+00:00",
      model: "gpt-realtime",
      status: "ok",
      duracao_ms: 600_000,
      custo_usd_cents: 48,
      custo_brl_cents: 239.4816,
      cotacao: 4.9892,
      cotacao_data: "2026-10-09",
    },
  ],
  cotacao_atual: { data: "2026-10-09", venda: "4.9892" },
};

function custo(extra: Partial<CustoDasLigacoes["totais"]> = {}, semCotacao = false): CustoDasLigacoes {
  const base = custoDasLigacoesSchema.parse(DO_BANCO);
  return { ...base, totais: { ...base.totais, ...extra }, cotacao_atual: semCotacao ? null : base.cotacao_atual };
}

describe("custo das ligações — formato e médias", () => {
  it("aceita numeric vindo como texto", () => {
    const c = custoDasLigacoesSchema.parse(DO_BANCO);
    expect(c.totais.custo_brl_cents).toBeCloseTo(299.352);
    expect(c.cotacao_atual).toEqual({ data: "2026-10-09", venda: 4.9892 });
  });

  it("média por ligação e por minuto em reais", () => {
    const m = mediasDasLigacoes(custo());
    expect(m.minutos).toBe(15);
    expect(m.porLigacaoBrlCents).toBeCloseTo(149.676);
    expect(m.porMinutoBrlCents).toBeCloseTo(299.352 / 15);
  });

  it("ligação sem preço sai do numerador E do denominador", () => {
    // 3 ligações, 1 sem preço: o total em reais é das 2 com preço.
    const m = mediasDasLigacoes(custo({ ligacoes: 3, sem_preco: 1 }));
    expect(m.porLigacaoBrlCents).toBeCloseTo(299.352 / 2);
  });

  it("sem cotação não há média em reais", () => {
    const m = mediasDasLigacoes(custo({ custo_brl_cents: 0 }, true));
    expect(m.porLigacaoBrlCents).toBeNull();
    expect(m.porMinutoBrlCents).toBeNull();
  });
});

describe("CustoDasLigacoesCard", () => {
  it("mostra o total em reais, o dólar e a cotação PTAX do dia", () => {
    render(<CustoDasLigacoesCard custo={custo()} idioma="pt-BR" />);
    expect(screen.getByTestId("custo-total-brl").textContent).toMatch(/R\$\s?2,99/);
    expect(screen.getByText(/US\$\s?0,60/)).toBeTruthy();
    expect(screen.getByTestId("cotacao-atual").textContent).toContain("PTAX 09/10/2026");
    // a ligação de 10 min a US$ 0,48 → R$ 2,39 na PTAX de 09/10
    expect(screen.getByText(/R\$\s?2,39/)).toBeTruthy();
    expect(screen.getByText("10:00")).toBeTruthy();
  });

  it("sem cotação ainda: mostra o dólar e diz por que não há reais — nunca R$ 0,00", () => {
    render(<CustoDasLigacoesCard custo={custo({ custo_brl_cents: 0 }, true)} idioma="pt-BR" />);
    expect(screen.getByTestId("custo-total-brl").textContent).toBe("—");
    expect(screen.getByText(/ainda não foi obtida do Banco Central/)).toBeTruthy();
  });

  it("avisa quando há ligação de modelo sem tarifa", () => {
    render(<CustoDasLigacoesCard custo={custo({ ligacoes: 3, sem_preco: 1 })} idioma="pt-BR" />);
    expect(screen.getByText(/sem tarifa conhecida/)).toBeTruthy();
  });

  it("em espanhol", () => {
    render(<CustoDasLigacoesCard custo={custo()} idioma="es" />);
    expect(screen.getByText("Llamadas de voz")).toBeTruthy();
    expect(screen.getByText("Costo por minuto")).toBeTruthy();
  });
});
