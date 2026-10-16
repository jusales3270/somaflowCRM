/**
 * O livro de custo dos provedores EXTERNOS da prospecção B2B (CNPJá, Treg), em
 * `prospecting_provider_costs` (migration 9003). A tela Uso e orçamento lê pela
 * `fn_custo_dos_provedores`.
 *
 * Fica fora de `llm_calls` de propósito: lá o gasto entraria no teto mensal de IA,
 * e uma busca de empresas poderia parar as respostas da IA no WhatsApp.
 *
 * Gravar custo nunca derruba a operação que gastou: o dinheiro já saiu, e perder a
 * empresa ou o contato por causa do registro seria pagar duas vezes. A falha vira
 * log de erro (Sentry), como a auditoria.
 */
import type pg from "pg";
import { z } from "zod";

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export interface LancamentoDeCusto {
  provider: "cnpja" | "treg";
  operacao: string;
  unidades: number;
  custoUsdMicro?: number | null;
  custoBrlCents?: number | null;
  referenciaId?: string | null;
  callId?: string | null;
}

export async function registrarCusto(
  db: pg.Pool | pg.PoolClient,
  org: string,
  l: LancamentoDeCusto,
): Promise<void> {
  try {
    await db.query(
      `insert into prospecting_provider_costs
         (organization_id,provider,operacao,unidades,custo_usd_micro,custo_brl_cents,referencia_id,call_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (organization_id,provider,call_id) where call_id is not null do nothing`,
      [
        org,
        l.provider,
        l.operacao,
        l.unidades,
        l.custoUsdMicro ?? null,
        l.custoBrlCents ?? null,
        l.referenciaId ?? null,
        l.callId ?? null,
      ],
    );
  } catch (e) {
    logger.error("[prospeccao-b2b] custo do provedor não foi registrado", {
      organization_id: org,
      provider: l.provider,
      operacao: l.operacao,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** R$ (em centavos) das unidades da CNPJá ao preço do crédito da organização. */
export function centavosDosCreditos(creditos: number, precoDoCredito: number): number {
  return Math.round(creditos * precoDoCredito * 100 * 10000) / 10000;
}

const numero = z.coerce.number();

export const custoDosProvedoresSchema = z.object({
  provedores: z.array(
    z.object({
      provider: z.enum(["cnpja", "treg"]),
      chamadas: numero,
      unidades: numero,
      custo_usd_micro: numero,
      custo_brl_cents: numero,
      sem_cotacao: numero,
      operacoes: z.record(z.string(), numero).nullable().default({}),
    }),
  ),
  total_brl_cents: numero,
  cotacao_atual: z.object({ data: z.string(), venda: numero }).nullable(),
});

export type CustoDosProvedores = z.infer<typeof custoDosProvedoresSchema>;

/**
 * Lê o custo do período pela função do banco (service role: as tabelas da
 * prospecção B2B não têm política para `authenticated`). A organização vem de
 * quem chama — resolvida da sessão, nunca do corpo. Devolve `null` quando não há
 * nada a mostrar ou a leitura falha: o card é informativo e nunca derruba a tela.
 */
export async function lerCustoDosProvedores(org: string, dias = 30): Promise<CustoDosProvedores | null> {
  const ate = new Date();
  const desde = new Date(ate.getTime() - dias * 86_400_000);
  const { data, error } = await createAdminClient().rpc("fn_custo_dos_provedores", {
    p_org: org,
    p_desde: desde.toISOString(),
    p_ate: ate.toISOString(),
  });
  if (error) {
    logger.warn("[uso] custo dos provedores externos indisponível", { organization_id: org, error: error.message });
    return null;
  }
  const lido = custoDosProvedoresSchema.safeParse(data);
  if (!lido.success) {
    logger.warn("[uso] custo dos provedores externos em formato inesperado", { organization_id: org });
    return null;
  }
  return lido.data.provedores.length ? lido.data : null;
}
