/**
 * Prospecção B2B por CNPJ — busca de empresas por CNAE, estado/cidade e porte
 * (faturamento acima de R$ 4,8 mi/ano pelo porte "Demais" da Receita), ao LADO do
 * motor do Google Maps (`/api/v1/prospecting`, que não muda).
 *
 * GET  → chaves configuradas, buscas recentes e, com `?search=<id>`, as empresas.
 * POST → `configure_credential`, `test_credential`, `set_price`, `suggest_cnae`,
 *        `search`, `load_more`, `select`, `qualify` (nota do Jev),
 *        `enrich_start` / `enrich_step` / `enrich_cancel` (decisores pelo Treg),
 *        `contact_remove` (remove o decisor e não o busca de novo).
 *
 * Só admin, por sessão ou bearer (`resolveAuthDual`). A lista B2B não envia nada a
 * ninguém: sai por exportação (`./exportar`). Toda mutação audita
 * `prospecting_b2b.changed`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { provedorOferecido } from "@/lib/ai/pontos/provedores-oferecidos";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { ErroDaCnpja } from "@/lib/prospecting/b2b/cnpja";
import {
  definirPrecoDaUnidade,
  ErroDeCredencial,
  estadoDasCredenciais,
  lerCredencial,
  marcarVerificada,
  salvarCredencial,
  testarChave,
} from "@/lib/prospecting/b2b/credenciais";
import {
  cancelarRodada,
  ErroDosDecisores,
  iniciarRodada,
  listarContatos,
  listarRodadas,
  processarRodada,
  removerContato,
} from "@/lib/prospecting/b2b/decisores";
import { ErroDaQualificacao, jevConfigurado, qualificarBusca } from "@/lib/prospecting/b2b/qualificar";
import { b2bInputSchema } from "@/lib/prospecting/b2b/schema";
import {
  carregarMais,
  criarBusca,
  ErroDaBuscaB2b,
  listarBuscas,
  listarEmpresas,
  selecionar,
} from "@/lib/prospecting/b2b/store";
import { sugerirCnaes } from "@/lib/prospecting/b2b/sugerir-cnae";
import { ErroDoTreg } from "@/lib/prospecting/b2b/treg";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
const headers = { "Cache-Control": "no-store" };

/**
 * Tetos por organização, por hora: a busca gasta crédito; a sugestão e a nota
 * gastam IA; a rodada de decisores gasta Treg (o passo é o laço da tela, que
 * avança a rodada a cada poucos segundos).
 */
const TETOS = { search: 30, load_more: 60, suggest_cnae: 30, qualify: 60, enrich_start: 20, enrich_step: 1200 } as const;

/** Quanto um passo de decisores roda dentro do pedido HTTP. */
const PRAZO_DO_PASSO_MS = 20_000;

function falha(e: unknown, requestId: string) {
  if (
    e instanceof ErroDaCnpja ||
    e instanceof ErroDeCredencial ||
    e instanceof ErroDaBuscaB2b ||
    e instanceof ErroDoTreg ||
    e instanceof ErroDosDecisores ||
    e instanceof ErroDaQualificacao
  )
    return fail("prospecting_b2b_unavailable", e.message, e.status, { requestId, headers });
  logger.error("[prospeccao-b2b] erro inesperado", {
    request_id: requestId,
    error: e instanceof Error ? e.message : String(e),
  });
  return fail(
    "prospecting_b2b_unavailable",
    "Não foi possível concluir a operação. Tente de novo em instantes.",
    500,
    { requestId, headers },
  );
}

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const auth = await resolveAuthDual(req, {
    requestId,
    resource: "prospecting",
    role: "admin",
    scope: "mcp:read",
  });
  if (!auth.ok) return auth.response;
  try {
    const db = getRequestPool();
    const org = auth.organizationId;
    const searchId = req.nextUrl.searchParams.get("search");
    const daBusca = !!searchId && /^[0-9a-f-]{36}$/i.test(searchId);
    const [credenciais, buscas, empresas, rodadas, contatos, jev, cotacao] = await Promise.all([
      estadoDasCredenciais(db, org),
      listarBuscas(db, org),
      daBusca ? listarEmpresas(db, org, searchId!) : Promise.resolve([]),
      daBusca ? listarRodadas(db, org, searchId!) : Promise.resolve([]),
      daBusca ? listarContatos(db, org, searchId!) : Promise.resolve([]),
      jevConfigurado(db, org),
      // A PTAX mais recente (tabela global, 9001): a tela mostra o teto do Treg também em R$.
      db.query<{ venda: string }>("select venda from cotacoes_do_dolar order by data desc limit 1").then(
        (r) => (r.rows[0] ? Number(r.rows[0].venda) : null),
      ),
    ]);
    return ok(
      { credenciais, buscas, empresas, rodadas, contatos, jev_configurado: jev, cotacao_dolar: cotacao },
      { requestId, headers },
    );
  } catch (e) {
    return falha(e, requestId);
  }
}

export async function POST(req: NextRequest) {
  const negado = await requireSupportWrite();
  if (negado) return negado;
  const requestId = randomUUID();
  const auth = await resolveAuthDual(req, {
    requestId,
    resource: "prospecting",
    role: "admin",
    scope: "mcp:write",
  });
  if (!auth.ok) return auth.response;
  const teto = await tetoDeEscritaDoToken(auth, "prospecting", requestId);
  if (teto) return teto;

  const parsed = b2bInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_failed", "Confira os campos da busca: CNAE, estados ou cidades e limites.", 422, {
      requestId,
      headers,
      details: parsed.error.flatten(),
    });
  const body = parsed.data;
  const org = auth.organizationId;
  const userId = auth.actor.type === "user" ? auth.actor.id : null;

  if (body.action in TETOS) {
    const limite = TETOS[body.action as keyof typeof TETOS];
    const taxa = await checkRateLimit(`prospecting_b2b:${body.action}:${org}`, limite, 3600);
    if (!taxa.allowed)
      return fail("rate_limited", "Muitas buscas nesta hora. Aguarde um pouco e tente de novo.", 429, {
        requestId,
        headers: { ...headers, "Retry-After": "3600" },
      });
  }

  try {
    const pool = getRequestPool();
    const admin = createAdminClient();
    let resultado: unknown;
    let metadata: Record<string, unknown> = { operation: body.action };
    let audita = true;

    if (body.action === "configure_credential") {
      resultado = await salvarCredencial(pool, admin, org, body.provider, body.api_key);
      metadata = { operation: body.action, provider: body.provider };
    } else if (body.action === "test_credential") {
      const chave = await lerCredencial(pool, admin, org, body.provider);
      resultado = await testarChave(body.provider, chave);
      await marcarVerificada(pool, org, body.provider);
      audita = false;
    } else if (body.action === "set_price") {
      await definirPrecoDaUnidade(pool, org, body.provider, body.preco_unidade_brl);
      resultado = { preco_unidade_brl: body.preco_unidade_brl };
      metadata = { operation: body.action, provider: body.provider, preco_unidade_brl: body.preco_unidade_brl };
    } else if (body.action === "suggest_cnae") {
      resultado = await sugerirCnaes(pool, org, body.descricao, await provedorOferecido(admin));
      audita = false;
    } else if (body.action === "search") {
      const r = await criarBusca(pool, admin, org, userId, body.request_id, body.name, body.filtros);
      resultado = r;
      metadata = {
        operation: body.action,
        search_id: r.busca.id,
        cnaes: body.filtros.cnaes.length,
        ufs: body.filtros.ufs,
        municipios: body.filtros.municipios.length,
        portes: body.filtros.portes,
        empresas: r.busca.results_count,
        creditos: r.busca.credits_used,
        repetida: r.repetida,
      };
    } else if (body.action === "load_more") {
      const busca = await carregarMais(pool, admin, org, body.id);
      resultado = { busca };
      metadata = { operation: body.action, search_id: body.id, empresas: busca.results_count, creditos: busca.credits_used };
    } else if (body.action === "qualify") {
      const r = await qualificarBusca(pool, org, body.id);
      resultado = r;
      metadata = { operation: body.action, search_id: body.id, ...r };
    } else if (body.action === "enrich_start") {
      const r = await iniciarRodada(pool, admin, org, userId, body);
      resultado = r;
      metadata = {
        operation: body.action,
        search_id: body.search_id,
        run_id: r.rodada.id,
        cargos: body.cargos,
        por_empresa: body.por_empresa,
        com_celular: body.com_celular,
        teto_usd: body.teto_usd,
        empresas: r.rodada.empresas_total,
        repetida: r.repetida,
      };
    } else if (body.action === "enrich_step") {
      const antes = Date.now();
      const rodada = await processarRodada(pool, admin, org, body.run_id, PRAZO_DO_PASSO_MS);
      resultado = { rodada };
      // O passo é o laço da tela: audita só quando terminou a rodada (o efeito
      // que importa); o gasto de cada chamada está no livro de custo.
      audita = rodada.status !== "running";
      metadata = {
        operation: "enrich_finished",
        run_id: body.run_id,
        status: rodada.status,
        empresas: rodada.empresas_feitas,
        contatos: rodada.contatos_achados,
        gasto_usd: rodada.gasto_micro / 1_000_000,
        ms: Date.now() - antes,
      };
    } else if (body.action === "enrich_cancel") {
      const rodada = await cancelarRodada(pool, org, body.run_id);
      resultado = { rodada };
      metadata = { operation: body.action, run_id: body.run_id };
    } else if (body.action === "contact_remove") {
      await removerContato(pool, org, body.contact_id);
      resultado = { removido: true };
      metadata = { operation: body.action, contact_id: body.contact_id, suprimido: true };
    } else {
      const alteradas = await selecionar(pool, org, body.id, body.selected, body.company_ids);
      resultado = { alteradas };
      metadata = { operation: body.action, search_id: body.id, selected: body.selected, alteradas };
    }

    if (audita)
      void audit({
        action: "prospecting_b2b.changed",
        organizationId: org,
        actorUserId: userId,
        actorApiTokenId: auth.apiTokenId ?? null,
        resourceType: "prospecting_b2b",
        metadata,
        requestId,
      });
    return ok(resultado, { requestId, headers });
  } catch (e) {
    return falha(e, requestId);
  }
}
