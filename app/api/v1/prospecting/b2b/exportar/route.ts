/**
 * GET /api/v1/prospecting/b2b/exportar?search=<id> — as empresas SELECIONADAS da
 * busca, em CSV (`;`, UTF-8 com BOM: abre direto no Excel em português).
 *
 * Exportar é dado saindo do sistema: audita `prospecting_b2b.exported` com a
 * contagem. Só admin, por sessão ou bearer.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { exportarCsv } from "@/lib/prospecting/b2b/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const auth = await resolveAuthDual(req, {
    requestId,
    resource: "prospecting",
    role: "admin",
    scope: "mcp:read",
  });
  if (!auth.ok) return auth.response;
  const teto = await tetoDeEscritaDoToken(auth, "prospecting", requestId);
  if (teto) return teto;
  const searchId = req.nextUrl.searchParams.get("search") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(searchId))
    return fail("validation_failed", "Informe a busca a exportar.", 422, { requestId });
  try {
    const db = getRequestPool();
    const org = auth.organizationId;
    const existe = await db.query(
      "select name from prospecting_b2b_searches where organization_id=$1 and id=$2",
      [org, searchId],
    );
    if (!existe.rows[0]) return fail("not_found", "Busca não encontrada.", 404, { requestId });
    const { csv, linhas } = await exportarCsv(db, org, searchId);
    void audit({
      action: "prospecting_b2b.exported",
      organizationId: org,
      actorUserId: auth.actor.type === "user" ? auth.actor.id : null,
      actorApiTokenId: auth.apiTokenId ?? null,
      resourceType: "prospecting_b2b",
      resourceId: searchId,
      metadata: { search_id: searchId, empresas: linhas },
      requestId,
    });
    const nome = String(existe.rows[0].name ?? "empresas")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "empresas";
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="prospeccao-b2b-${nome}.csv"`,
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (e) {
    logger.error("[prospeccao-b2b] exportação falhou", {
      request_id: requestId,
      error: e instanceof Error ? e.message : String(e),
    });
    return fail("internal_error", "Não foi possível exportar agora.", 500, { requestId });
  }
}
