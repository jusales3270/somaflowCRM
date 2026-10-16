/**
 * Prospecção B2B por CNPJ — busca de empresas por CNAE, estado/cidade e porte
 * (faturamento acima de R$ 4,8 mi/ano pelo porte "Demais" da Receita), ao LADO do
 * motor do Google Maps (`/api/v1/prospecting`, que não muda).
 *
 * GET  → chaves configuradas, buscas recentes e, com `?search=<id>`, as empresas.
 * POST → `configure_credential`, `test_credential`, `suggest_cnae`, `search`,
 *        `load_more`, `select`.
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
  ErroDeCredencial,
  estadoDasCredenciais,
  lerCredencial,
  marcarVerificada,
  salvarCredencial,
  testarChave,
} from "@/lib/prospecting/b2b/credenciais";
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
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
const headers = { "Cache-Control": "no-store" };

/** Tetos por organização, por hora: a busca gasta crédito; a sugestão gasta IA. */
const TETOS = { search: 30, load_more: 60, suggest_cnae: 30 } as const;

function falha(e: unknown, requestId: string) {
  if (e instanceof ErroDaCnpja || e instanceof ErroDeCredencial || e instanceof ErroDaBuscaB2b)
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
    const [credenciais, buscas, empresas] = await Promise.all([
      estadoDasCredenciais(db, org),
      listarBuscas(db, org),
      searchId && /^[0-9a-f-]{36}$/i.test(searchId) ? listarEmpresas(db, org, searchId) : Promise.resolve([]),
    ]);
    return ok({ credenciais, buscas, empresas }, { requestId, headers });
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
      if (body.provider === "cnpja") await marcarVerificada(pool, org, body.provider);
      audita = false;
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
