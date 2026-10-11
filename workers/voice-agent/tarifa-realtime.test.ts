import { describe, expect, it } from "vitest";

import { custoDaLigacaoEmCentavos, tarifaDoModelo } from "./tarifa-realtime";
import { usoVazio, type UsoDaSessao } from "./uso-da-sessao";

/** Um milhão de tokens de um tipo só — o custo em centavos é a tarifa × 100. */
function milhaoDe(campo: keyof UsoDaSessao, extra: Partial<UsoDaSessao> = {}): UsoDaSessao {
  return { ...usoVazio(), [campo]: 1_000_000, ...extra };
}

describe("tarifa da OpenAI Realtime (developers.openai.com/api/docs/pricing, 11/10/2026)", () => {
  // Os números da página oficial, fixados: mudar um deles é decisão revisada.
  it.each([
    ["gpt-realtime", 4, 0.4, 16, 32, 0.4, 64],
    ["gpt-realtime-mini", 0.6, 0.06, 2.4, 10, 0.3, 20],
    ["gpt-realtime-2", 4, 0.4, 24, 32, 0.4, 64],
    ["gpt-realtime-2.1", 4, 0.4, 24, 32, 0.4, 64],
    ["gpt-realtime-2.1-mini", 0.6, 0.06, 2.4, 10, 0.3, 20],
  ])("%s", (modelo, textoEntrada, textoCache, textoSaida, audioEntrada, audioCache, audioSaida) => {
    expect(tarifaDoModelo(modelo)).toEqual({
      textoEntrada,
      textoCache,
      textoSaida,
      audioEntrada,
      audioCache,
      audioSaida,
    });
  });

  it("aceita o prefixo openai/ e o sufixo de data dos snapshots", () => {
    expect(tarifaDoModelo("openai/gpt-realtime")).toEqual(tarifaDoModelo("gpt-realtime"));
    expect(tarifaDoModelo("gpt-realtime-2025-08-28")).toEqual(tarifaDoModelo("gpt-realtime"));
    expect(tarifaDoModelo(" GPT-Realtime-Mini ")).toEqual(tarifaDoModelo("gpt-realtime-mini"));
  });

  it("modelo fora da tabela não tem tarifa (custo desconhecido, nunca zero)", () => {
    expect(tarifaDoModelo("gpt-4o")).toBeNull();
    expect(custoDaLigacaoEmCentavos("gpt-4o", milhaoDe("entradaAudio"))).toBeNull();
  });
});

describe("custo da ligação em centavos de dólar", () => {
  it("cada tipo de token paga a própria tarifa", () => {
    expect(custoDaLigacaoEmCentavos("gpt-realtime", milhaoDe("entradaAudio"))).toBeCloseTo(3200);
    expect(custoDaLigacaoEmCentavos("gpt-realtime", milhaoDe("entradaTexto"))).toBeCloseTo(400);
    expect(custoDaLigacaoEmCentavos("gpt-realtime", milhaoDe("saidaAudio"))).toBeCloseTo(6400);
    expect(custoDaLigacaoEmCentavos("gpt-realtime", milhaoDe("saidaTexto"))).toBeCloseTo(1600);
  });

  it("a parte em cache paga a tarifa de cache, não a cheia", () => {
    const tudoEmCache = milhaoDe("entradaAudio", { entradaCache: 1_000_000, entradaCacheAudio: 1_000_000 });
    expect(custoDaLigacaoEmCentavos("gpt-realtime", tudoEmCache)).toBeCloseTo(40);
  });

  it("sem o detalhe por tipo, o cache vai primeiro para o áudio (erra cobrando a mais)", () => {
    // 1M de áudio + 1M de texto, 1M em cache sem detalhe: no mini o cache de
    // áudio ($0,30) é mais caro que o de texto ($0,06), então atribuir ao áudio
    // dá o MAIOR dos dois custos possíveis.
    const uso = { ...usoVazio(), entradaAudio: 1_000_000, entradaTexto: 1_000_000, entradaCache: 1_000_000 };
    expect(custoDaLigacaoEmCentavos("gpt-realtime-mini", uso)).toBeCloseTo(30 + 60);
  });

  it("detalhe de cache maior que o total do tipo não gera custo negativo", () => {
    const uso = { ...usoVazio(), entradaAudio: 100, entradaCache: 500, entradaCacheAudio: 500 };
    expect(custoDaLigacaoEmCentavos("gpt-realtime", uso)).toBeGreaterThanOrEqual(0);
  });

  it("ligação sem resposta medida custa zero — preço conhecido, uso nenhum", () => {
    expect(custoDaLigacaoEmCentavos("gpt-realtime", usoVazio())).toBe(0);
  });
});
