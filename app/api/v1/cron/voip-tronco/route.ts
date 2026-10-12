/**
 * GET/POST /api/v1/cron/voip-tronco — o Asterisk reflete o que está no banco.
 *
 * Salvar o tronco na tela já o aplica (PUT de `/api/v1/voip/trunk`). Esta rota
 * cobre o resto: o contêiner do Asterisk foi recriado sem o volume, a
 * instalação ligou a telefonia depois de o tronco ter sido salvo, ou o Asterisk
 * estava fora na hora de salvar. Tronco ativo que não está lá → aplica;
 * desativado que ainda está → remove. Tronco que já está lá NÃO é reaplicado:
 * recriar o registro a cada rodada derrubaria o login no provedor à toa.
 *
 * Sem telefonia na instalação (sem ARI no ambiente) ou sem tronco nenhum, sai
 * sem tocar em nada — e não audita: só a rodada que mudou o Asterisk deixa
 * linha, uma por organização (`voip_trunk.aplicado_no_asterisk` /
 * `voip_trunk.removido_do_asterisk`).
 *
 * Auth: segredo do cron (`lib/auth/cron-auth.ts`). Agendamento: `scheduler`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerTronco } from "@/lib/voip/tronco-da-organizacao";
import {
  aplicarTronco,
  asteriskAlcancavel,
  configDaAriDoAmbiente,
  removerTronco,
  troncoPresente,
} from "@/lib/voip/tronco-no-asterisk";

export const dynamic = "force-dynamic";

export interface ResultadoDaReconciliacao {
  sem_telefonia?: true;
  asterisk_fora?: true;
  troncos: number;
  aplicados: number;
  removidos: number;
  falhas: number;
}

export async function reconciliarTroncos(
  admin: ReturnType<typeof createAdminClient>,
  requestId: string,
): Promise<ResultadoDaReconciliacao> {
  const r: ResultadoDaReconciliacao = { troncos: 0, aplicados: 0, removidos: 0, falhas: 0 };
  const cfg = configDaAriDoAmbiente();
  if (!cfg) return { ...r, sem_telefonia: true };

  const { data, error } = await admin.from("voip_trunk_settings").select("organization_id, is_active");
  if (error) throw new Error(`voip_trunk_leitura_falhou: ${error.message}`);
  const linhas = (data ?? []) as Array<{ organization_id: string; is_active: boolean }>;
  r.troncos = linhas.length;
  if (linhas.length === 0) return r;
  if (!(await asteriskAlcancavel(cfg))) return { ...r, asterisk_fora: true };

  for (const linha of linhas) {
    const orgId = linha.organization_id;
    try {
      const presente = await troncoPresente(orgId, cfg);
      if (linha.is_active && !presente) {
        const tronco = await lerTronco(admin, orgId);
        if (!tronco) continue;
        const feito = await aplicarTronco(tronco.dados, cfg);
        if (!feito.ok) {
          r.falhas++;
          logger.warn("[voip-tronco] aplicar falhou", { organization_id: orgId, motivo: feito.motivo });
          continue;
        }
        r.aplicados++;
        void audit({
          action: "voip_trunk.aplicado_no_asterisk",
          organizationId: orgId,
          bypassedRls: true,
          resourceType: "voip_trunk_settings",
          resourceId: orgId,
          metadata: { origem: "reconciliacao" },
          requestId,
        });
      } else if (!linha.is_active && presente) {
        const feito = await removerTronco(orgId, cfg);
        if (!feito.ok) {
          r.falhas++;
          continue;
        }
        r.removidos++;
        void audit({
          action: "voip_trunk.removido_do_asterisk",
          organizationId: orgId,
          bypassedRls: true,
          resourceType: "voip_trunk_settings",
          resourceId: orgId,
          metadata: { origem: "reconciliacao" },
          requestId,
        });
      }
    } catch (err) {
      r.falhas++;
      logger.warn("[voip-tronco] organização falhou", {
        organization_id: orgId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return r;
}

async function handler(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("unauthorized", "cron secret ausente ou inválido", 401, { requestId });
  }
  try {
    const resultado = await reconciliarTroncos(createAdminClient(), requestId);
    if (resultado.aplicados || resultado.removidos || resultado.falhas) {
      logger.info("[voip-tronco] rodada", { ...resultado, request_id: requestId });
    }
    return ok(resultado, { requestId });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[voip-tronco] falhou", { error: detalhe, request_id: requestId });
    return fail("cron_failed", detalhe, 500, { requestId });
  }
}

export const GET = handler;
export const POST = handler;
