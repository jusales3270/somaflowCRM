/**
 * O USO DE UMA LIGAÇÃO NA OPENAI REALTIME — medido, somado e virado UMA linha
 * de `llm_calls` no fim da chamada. Puro: sem rede, sem banco, sem relógio.
 *
 * ═══ POR QUE ═══
 *
 * A sessão de voz é o gasto mais caro por minuto do produto e não deixava linha
 * nenhuma: a tela de Uso de IA mostrava zero para quem atende por telefone.
 *
 * ═══ O QUE É MEDIDO DE VERDADE ═══
 *
 * Cada `response.done` da Realtime API traz `response.usage` com os tokens
 * daquela resposta (entrada e saída, cada um com o detalhe texto/áudio/cache).
 * Esta soma é o uso REAL da sessão, vindo do provedor — nada estimado. A
 * duração da ligação vai em `latency_ms`, que é o "quanto tempo durou" desta
 * chamada (não é latência de resposta).
 *
 * ═══ O PREÇO ═══
 *
 * `cost_cents` sai da tabela de tarifas da Realtime (`./tarifa-realtime.ts`):
 * seis preços por modelo — texto e áudio, cada um com entrada, cache e saída —,
 * com fonte e data de conferência escritas lá. `ai_pricing` e `pricing.ts` têm
 * um preço de entrada e um de saída por modelo, e precificariam o áudio como
 * texto; por isso a voz tem tabela própria. Com o custo na linha, a ligação
 * entra na régua do teto (`fn_gasto_de_ia_do_mes`) e no total de Uso de IA.
 *
 * Modelo FORA da tabela continua saindo NULO, e não 0: é o nulo que DIZ isso
 * na tela — `getBudgetStatus` conta linha `ok` com `cost_cents` nulo como
 * `gasto_incompleto`, e o card de Orçamento avisa que o gasto medido é menor
 * que o real. Um 0 seria número com cara de medido.
 */
import type { ChamadaDeIa } from "@/lib/ai/usage/registrar-chamada";

import { custoDaLigacaoEmCentavos } from "./tarifa-realtime";

/**
 * O `purpose` da sessão de voz em `llm_calls`.
 *
 * ⚠️ PENDENTE: ainda não é ponto de `lib/ai/pontos/registro.ts` — a tela de
 * Execuções o mostra cru até o ponto existir lá (com `registraEm: "llm_calls"`).
 */
export const PURPOSE_DA_VOZ = "voz_ao_vivo";

export interface UsoDaSessao {
  /** Quantos `response.done` trouxeram uso. */
  respostas: number;
  entrada: number;
  saida: number;
  entradaAudio: number;
  entradaTexto: number;
  entradaCache: number;
  /** A parte de `entradaCache` que era áudio / texto (`cached_tokens_details`). */
  entradaCacheAudio: number;
  entradaCacheTexto: number;
  saidaAudio: number;
  saidaTexto: number;
}

export function usoVazio(): UsoDaSessao {
  return {
    respostas: 0,
    entrada: 0,
    saida: 0,
    entradaAudio: 0,
    entradaTexto: 0,
    entradaCache: 0,
    entradaCacheAudio: 0,
    entradaCacheTexto: 0,
    saidaAudio: 0,
    saidaTexto: 0,
  };
}

/** Número finito e não negativo, ou 0 — o evento vem de fora e não é validado. */
function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Soma o `response.usage` de um `response.done` ao acumulado. Evento sem uso
 * (resposta cancelada antes de gerar, ou formato que mudou) não conta como
 * resposta medida — devolve o acumulado como estava.
 */
export function somarUsoDaResposta(acumulado: UsoDaSessao, usage: unknown): UsoDaSessao {
  if (usage === null || typeof usage !== "object") return acumulado;
  const u = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_token_details?: {
      audio_tokens?: unknown;
      text_tokens?: unknown;
      cached_tokens?: unknown;
      cached_tokens_details?: { audio_tokens?: unknown; text_tokens?: unknown };
    };
    output_token_details?: { audio_tokens?: unknown; text_tokens?: unknown };
  };
  return {
    respostas: acumulado.respostas + 1,
    entrada: acumulado.entrada + n(u.input_tokens),
    saida: acumulado.saida + n(u.output_tokens),
    entradaAudio: acumulado.entradaAudio + n(u.input_token_details?.audio_tokens),
    entradaTexto: acumulado.entradaTexto + n(u.input_token_details?.text_tokens),
    entradaCache: acumulado.entradaCache + n(u.input_token_details?.cached_tokens),
    entradaCacheAudio:
      acumulado.entradaCacheAudio + n(u.input_token_details?.cached_tokens_details?.audio_tokens),
    entradaCacheTexto:
      acumulado.entradaCacheTexto + n(u.input_token_details?.cached_tokens_details?.text_tokens),
    saidaAudio: acumulado.saidaAudio + n(u.output_token_details?.audio_tokens),
    saidaTexto: acumulado.saidaTexto + n(u.output_token_details?.text_tokens),
  };
}

/**
 * A linha da ligação. `erro` só quando a sessão nem abriu (handshake recusado
 * pela OpenAI — chave errada, sem saldo, modelo inexistente): é a falha que a
 * tela de Execuções precisa mostrar. Ligação que abriu e terminou é `ok`, com o
 * uso que houve.
 */
export function linhaDaLigacao(entrada: {
  organizationId: string;
  agentId: string | null;
  contactId: string | null;
  modelo: string;
  uso: UsoDaSessao;
  duracaoMs: number;
  erro: { message: string; status?: number } | null;
}): ChamadaDeIa {
  return {
    organization_id: entrada.organizationId,
    agent_id: entrada.agentId,
    contact_id: entrada.contactId,
    purpose: PURPOSE_DA_VOZ,
    provider: "openai",
    model: entrada.modelo,
    input_tokens: entrada.uso.entrada,
    output_tokens: entrada.uso.saida,
    // Ver o cabeçalho e `./tarifa-realtime.ts`: modelo sem tarifa → nulo, nunca 0.
    cost_cents: custoDaLigacaoEmCentavos(entrada.modelo, entrada.uso),
    latency_ms: entrada.duracaoMs,
    erro: entrada.erro,
  };
}
