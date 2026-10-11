/**
 * O custo das ligações de voz em reais — o formato que `fn_custo_das_ligacoes`
 * (migration 9001) devolve, validado, e as contas que a tela faz em cima dele.
 *
 * A soma e a conversão moram NO BANCO: cada ligação é convertida pela PTAX do
 * dia dela, e somar aqui pelo PostgREST perderia linhas depois da milésima
 * (`max_rows`). Este módulo só valida e deriva médias — nada de segunda régua.
 *
 * Centavos de DÓLAR e centavos de REAL, ambos fracionados: uma ligação curta
 * custa frações de centavo, e arredondar cedo somaria erro.
 */
import { z } from "zod";

const numero = z.coerce.number();
const numeroOuNulo = z.union([z.null(), z.coerce.number()]);

export const custoDasLigacoesSchema = z.object({
  totais: z.object({
    ligacoes: numero,
    falhas: numero,
    duracao_ms: numero,
    custo_usd_cents: numero,
    custo_brl_cents: numero,
    sem_preco: numero,
    sem_cotacao: numero,
  }),
  recentes: z.array(
    z.object({
      created_at: z.string(),
      model: z.string(),
      status: z.string(),
      duracao_ms: numeroOuNulo,
      custo_usd_cents: numeroOuNulo,
      custo_brl_cents: numeroOuNulo,
      cotacao: numeroOuNulo,
      cotacao_data: z.string().nullable(),
    }),
  ),
  cotacao_atual: z.object({ data: z.string(), venda: numero }).nullable(),
});

export type CustoDasLigacoes = z.infer<typeof custoDasLigacoesSchema>;

export interface MediasDasLigacoes {
  /** Centavos de real por ligação, ou `null` sem ligação com preço e cotação. */
  porLigacaoBrlCents: number | null;
  /** Centavos de real por minuto falado, ou `null` sem duração. */
  porMinutoBrlCents: number | null;
  minutos: number;
}

/**
 * Médias sobre as ligações que ENTRARAM no total em reais — as sem preço ou sem
 * cotação ficam fora do numerador, então saem do denominador também (senão a
 * média ficaria artificialmente baixa).
 */
export function mediasDasLigacoes(custo: CustoDasLigacoes): MediasDasLigacoes {
  const { totais } = custo;
  const minutos = totais.duracao_ms / 60_000;
  const contadas = totais.ligacoes - totais.sem_preco - totais.sem_cotacao;
  const temReais = contadas > 0 && totais.custo_brl_cents > 0;
  const fracaoContada = totais.ligacoes > 0 ? contadas / totais.ligacoes : 0;
  const minutosContados = minutos * fracaoContada;
  return {
    porLigacaoBrlCents: temReais ? totais.custo_brl_cents / contadas : null,
    porMinutoBrlCents: temReais && minutosContados > 0 ? totais.custo_brl_cents / minutosContados : null,
    minutos,
  };
}

/** `AAAA-MM-DD` → `DD/MM/AAAA` sem passar por `Date` (que trocaria o fuso). */
export function dataBr(dia: string): string {
  const [a, m, d] = dia.slice(0, 10).split("-");
  return `${d}/${m}/${a}`;
}

/** Reais sempre com 2 casas: é o que se lê numa fatura. */
export function formatarReais(centavos: number, tag: string): string {
  return (centavos / 100).toLocaleString(tag, {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Dólar com até 3 casas: a ligação curta custa frações de centavo de dólar. */
export function formatarDolares(centavos: number, tag: string): string {
  return (centavos / 100).toLocaleString(tag, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  });
}
