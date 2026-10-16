/**
 * GET /api/v1/prospecting/b2b/catalogos — pesquisa nos catálogos oficiais (IBGE)
 * que a prospecção B2B embute, para a tela não carregar os JSON inteiros:
 *   ?tipo=cnae&q=software            → subclasses CNAE (código ou palavras)
 *   ?tipo=municipio&q=camp&ufs=SP,MG → municípios, opcionalmente nas UFs
 * Só leitura; admin.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  buscarCnaes,
  buscarMunicipios,
  descricaoLegivel,
  UFS,
} from "@/lib/prospecting/b2b/catalogos";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "prospecting" });
  if (!authz.ok) return authz.response;
  const p = req.nextUrl.searchParams;
  const tipo = p.get("tipo");
  const q = (p.get("q") ?? "").slice(0, 120);
  if (tipo === "cnae") {
    return ok(
      { itens: buscarCnaes(q, 30).map((c) => ({ codigo: c.c, descricao: descricaoLegivel(c.d) })) },
      { requestId },
    );
  }
  if (tipo === "municipio") {
    const ufs = (p.get("ufs") ?? "")
      .split(",")
      .map((u) => u.trim().toUpperCase())
      .filter((u): u is (typeof UFS)[number] => (UFS as readonly string[]).includes(u));
    return ok(
      { itens: buscarMunicipios(q, ufs, 30).map((m) => ({ codigo: m.i, nome: m.n, uf: m.u })) },
      { requestId },
    );
  }
  return fail("validation_failed", "Informe tipo=cnae ou tipo=municipio.", 422, { requestId });
}
