/**
 * GET/POST /api/v1/cron/cotacao-do-dolar — a PTAX do Banco Central, todo dia.
 *
 * O gasto de IA é medido em centavos de DÓLAR (`llm_calls.cost_cents`). Para a
 * tela de Uso de IA mostrar quanto uma ligação custou em REAIS, cada ligação é
 * convertida pela PTAX do dia em que aconteceu (`fn_custo_das_ligacoes`) — e
 * esta rota é quem guarda essas cotações em `cotacoes_do_dolar`.
 *
 * Pede sempre os últimos `JANELA_DIAS` dias: fim de semana e feriado não têm
 * cotação, e um dia em que a instalação esteve fora se preenche na rodada
 * seguinte. Regravar a mesma cotação não muda nada (upsert por dia).
 *
 * Global, como `sync-model-catalog`: a cotação é da instalação inteira, não de
 * uma organização — por isso não audita (auditoria é por organização) e está
 * isenta em `tests/unit/cron-respeita-org-operante.test.ts`. A rodada fica no
 * log estruturado.
 *
 * Auth: mesmo contrato dos demais crons (`lib/auth/cron-auth.ts`).
 * Agendamento: serviço `scheduler` (`docker/scheduler/entrypoint.sh`), depois
 * da publicação da PTAX (~13h de Brasília) e de novo no fim do dia.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { buscarPtaxDoPeriodo, diaEmBrasilia, type CotacaoPtax } from "@/lib/cambio/ptax";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const JANELA_DIAS = 10;

export interface ResultadoDaCotacao {
  recebidas: number;
  mais_recente: CotacaoPtax | null;
}

/** Separado do handler para o teste exercitar a regra sem request nem auth. */
export async function guardarCotacoes(
  admin: ReturnType<typeof createAdminClient>,
  buscar: (inicio: string, fim: string) => Promise<CotacaoPtax[]>,
  agora: Date = new Date(),
): Promise<ResultadoDaCotacao> {
  const cotacoes = await buscar(diaEmBrasilia(agora, JANELA_DIAS), diaEmBrasilia(agora));
  if (cotacoes.length > 0) {
    const obtidaEm = agora.toISOString();
    const { error } = await admin.from("cotacoes_do_dolar").upsert(
      cotacoes.map((c) => ({
        data: c.data,
        venda: c.venda,
        compra: c.compra,
        fonte: "bcb_ptax",
        obtida_em: obtidaEm,
      })),
      { onConflict: "data" },
    );
    if (error) throw new Error(`cotacao_upsert_falhou: ${error.message}`);
  }
  return { recebidas: cotacoes.length, mais_recente: cotacoes.at(-1) ?? null };
}

async function handler(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("unauthorized", "cron secret ausente ou inválido", 401, { requestId });
  }
  try {
    const resultado = await guardarCotacoes(createAdminClient(), (inicio, fim) =>
      buscarPtaxDoPeriodo(inicio, fim),
    );
    logger.info("[cotacao-do-dolar] concluído", { ...resultado, request_id: requestId });
    return ok(resultado, { requestId });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[cotacao-do-dolar] falhou", { error: detalhe, request_id: requestId });
    return fail("cron_failed", detalhe, 500, { requestId });
  }
}

export const GET = handler;
export const POST = handler;
