/**
 * A TARIFA DA OPENAI REALTIME — o preço de uma ligação, a partir do uso medido.
 * Puro: sem rede, sem banco, sem relógio.
 *
 * ═══ POR QUE AQUI, E NÃO EM `ai_pricing` / `ai_models` ═══
 *
 * As duas tabelas guardam UM preço de entrada e UM de saída por modelo. A
 * Realtime cobra seis: texto e áudio, cada um com entrada, entrada em cache e
 * saída — e o áudio custa 8× o texto na entrada e 4× na saída. Precificar a
 * ligação por uma coluna só daria um número errado com cara de medido, que é o
 * que `workers/voice-agent/uso-da-sessao.ts` recusava enquanto não havia tarifa.
 *
 * ═══ FONTE ═══
 *
 * Tabela "Realtime and audio generation models" da página oficial de preços da
 * API da OpenAI, conferida em 11/10/2026 (o endereço está no teste e em
 * `docs/custo-das-ligacoes.md`).
 * Dólares por MILHÃO de tokens. Quando a OpenAI mudar o preço, muda aqui — e o
 * teste `./tarifa-realtime.test.ts` fixa os números, para a troca ser
 * deliberada e revisada.
 *
 * ═══ COMO O USO VIRA DINHEIRO ═══
 *
 * Em `response.usage`, `input_token_details.audio_tokens` e `.text_tokens` são
 * o TOTAL de entrada de cada tipo, e `cached_tokens` é a parte desse total que
 * veio do cache (com o detalhe por tipo em `cached_tokens_details`). A parte em
 * cache paga a tarifa de cache; o resto, a cheia. Sem o detalhe por tipo, o
 * cache é atribuído primeiro ao áudio — o lado de tarifa de cache mais alta,
 * para errar cobrando a mais, nunca a menos.
 */
import type { UsoDaSessao } from "./uso-da-sessao";

/** Dólares por milhão de tokens. */
export interface TarifaRealtime {
  textoEntrada: number;
  textoCache: number;
  textoSaida: number;
  audioEntrada: number;
  audioCache: number;
  audioSaida: number;
}

const GPT_REALTIME: TarifaRealtime = {
  textoEntrada: 4,
  textoCache: 0.4,
  textoSaida: 16,
  audioEntrada: 32,
  audioCache: 0.4,
  audioSaida: 64,
};

/** A geração 2 cobra o mesmo, menos a saída de texto: US$ 24 em vez de 16. */
const GPT_REALTIME_2: TarifaRealtime = { ...GPT_REALTIME, textoSaida: 24 };

const GPT_REALTIME_MINI: TarifaRealtime = {
  textoEntrada: 0.6,
  textoCache: 0.06,
  textoSaida: 2.4,
  audioEntrada: 10,
  audioCache: 0.3,
  audioSaida: 20,
};

const TARIFAS: Readonly<Record<string, TarifaRealtime>> = {
  "gpt-realtime": GPT_REALTIME,
  "gpt-realtime-mini": GPT_REALTIME_MINI,
  "gpt-realtime-2": GPT_REALTIME_2,
  "gpt-realtime-2.1": GPT_REALTIME_2,
  "gpt-realtime-2.1-mini": GPT_REALTIME_MINI,
};

/**
 * A tarifa do modelo, ou `null` quando ele não está na tabela — custo
 * DESCONHECIDO, nunca grátis (mesmo contrato de `lib/ai/runtime/cost.ts`).
 * Aceita o prefixo `openai/` e o sufixo de data dos snapshots
 * (`gpt-realtime-2025-08-28`), que a OpenAI cobra pelo preço do alias.
 */
export function tarifaDoModelo(modelo: string): TarifaRealtime | null {
  const id = modelo
    .trim()
    .toLowerCase()
    .replace(/^openai\//, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return TARIFAS[id] ?? null;
}

/**
 * O custo da ligação em CENTAVOS DE DÓLAR, fracionados — a unidade de
 * `llm_calls.cost_cents`. `null` = modelo sem tarifa conhecida.
 */
export function custoDaLigacaoEmCentavos(modelo: string, uso: UsoDaSessao): number | null {
  const tarifa = tarifaDoModelo(modelo);
  if (!tarifa) return null;

  const temDetalheDoCache = uso.entradaCacheAudio + uso.entradaCacheTexto > 0;
  const cacheAudio = temDetalheDoCache
    ? Math.min(uso.entradaCacheAudio, uso.entradaAudio)
    : Math.min(uso.entradaCache, uso.entradaAudio);
  const cacheTexto = temDetalheDoCache
    ? Math.min(uso.entradaCacheTexto, uso.entradaTexto)
    : Math.min(uso.entradaCache - cacheAudio, uso.entradaTexto);

  const dolares =
    (Math.max(0, uso.entradaAudio - cacheAudio) * tarifa.audioEntrada +
      cacheAudio * tarifa.audioCache +
      Math.max(0, uso.entradaTexto - cacheTexto) * tarifa.textoEntrada +
      cacheTexto * tarifa.textoCache +
      uso.saidaAudio * tarifa.audioSaida +
      uso.saidaTexto * tarifa.textoSaida) /
    1_000_000;

  return dolares * 100;
}
