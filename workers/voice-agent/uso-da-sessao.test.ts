import { describe, expect, it } from "vitest";

import { PURPOSE_DA_VOZ, linhaDaLigacao, somarUsoDaResposta, usoVazio } from "./uso-da-sessao";

/** Formato de `response.done.response.usage` da OpenAI Realtime. */
const USO_DE_UMA_RESPOSTA = {
  total_tokens: 330,
  input_tokens: 250,
  output_tokens: 80,
  input_token_details: { text_tokens: 50, audio_tokens: 200, cached_tokens: 40 },
  output_token_details: { text_tokens: 20, audio_tokens: 60 },
};

describe("uso da sessão de voz", () => {
  it("soma o uso de cada response.done", () => {
    const uso = somarUsoDaResposta(somarUsoDaResposta(usoVazio(), USO_DE_UMA_RESPOSTA), USO_DE_UMA_RESPOSTA);
    expect(uso).toEqual({
      respostas: 2,
      entrada: 500,
      saida: 160,
      entradaAudio: 400,
      entradaTexto: 100,
      entradaCache: 80,
      entradaCacheAudio: 0,
      entradaCacheTexto: 0,
      saidaAudio: 120,
      saidaTexto: 40,
    });
  });

  it("response.done sem usage (resposta cancelada) não conta", () => {
    expect(somarUsoDaResposta(usoVazio(), undefined)).toEqual(usoVazio());
    expect(somarUsoDaResposta(usoVazio(), null)).toEqual(usoVazio());
  });

  it("campo fora do formato vira 0, nunca NaN", () => {
    const uso = somarUsoDaResposta(usoVazio(), { input_tokens: "muitos", output_tokens: -3 });
    expect(uso.entrada).toBe(0);
    expect(uso.saida).toBe(0);
    expect(uso.respostas).toBe(1);
  });

  it("a linha da ligação leva tokens medidos, duração e o custo pela tarifa da Realtime", () => {
    const uso = somarUsoDaResposta(usoVazio(), USO_DE_UMA_RESPOSTA);
    expect(
      linhaDaLigacao({
        organizationId: "org1",
        agentId: "ag1",
        contactId: null,
        modelo: "gpt-realtime",
        uso,
        duracaoMs: 42_000,
        erro: null,
      }),
    ).toEqual({
      organization_id: "org1",
      agent_id: "ag1",
      contact_id: null,
      purpose: PURPOSE_DA_VOZ,
      provider: "openai",
      model: "gpt-realtime",
      input_tokens: 250,
      output_tokens: 80,
      // 160 áudio novo × $32 + 40 em cache × $0,40 + 50 texto × $4 + 60 áudio de
      // saída × $64 + 20 texto de saída × $16 = $0,009496 por 1M → 0,9496 centavo.
      cost_cents: expect.closeTo(0.9496, 10),
      latency_ms: 42_000,
      erro: null,
    });
  });

  it("soma o detalhe do cache por tipo quando a OpenAI o manda", () => {
    const uso = somarUsoDaResposta(usoVazio(), {
      ...USO_DE_UMA_RESPOSTA,
      input_token_details: {
        ...USO_DE_UMA_RESPOSTA.input_token_details,
        cached_tokens_details: { audio_tokens: 30, text_tokens: 10 },
      },
    });
    expect(uso.entradaCacheAudio).toBe(30);
    expect(uso.entradaCacheTexto).toBe(10);
  });

  it("modelo sem tarifa conhecida continua com custo NULO — desconhecido, nunca grátis", () => {
    const linha = linhaDaLigacao({
      organizationId: "org1",
      agentId: null,
      contactId: null,
      modelo: "gpt-realtime-9-experimental",
      uso: somarUsoDaResposta(usoVazio(), USO_DE_UMA_RESPOSTA),
      duracaoMs: 1_000,
      erro: null,
    });
    expect(linha.cost_cents).toBeNull();
  });

  it("handshake recusado vira linha de erro", () => {
    const linha = linhaDaLigacao({
      organizationId: "org1",
      agentId: "ag1",
      contactId: "c1",
      modelo: "gpt-realtime",
      uso: usoVazio(),
      duracaoMs: 300,
      erro: { message: "handshake rejeitado: invalid_api_key", status: 401 },
    });
    expect(linha.erro).toEqual({ message: "handshake rejeitado: invalid_api_key", status: 401 });
    expect(linha.input_tokens).toBe(0);
  });
});
