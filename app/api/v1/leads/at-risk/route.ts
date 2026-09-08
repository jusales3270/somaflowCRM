/**
 * Radar de Risco (desilhamento C1 — doutrina do sistema vivo). GET → demandas
 * ABERTAS (`crm_leads.status='open'`) que esfriaram, para o humano ver o que está
 * morrendo sem ninguém olhar. Enriquece com follow-up agendado (`cron_jobs` kind='at')
 * — se a IA prometeu voltar, a demanda está "em voo", não abandonada. Ver
 * docs/doctrine/sistema-vivo.md.
 *
 * A montagem do radar vive em `lib/leads/radar-de-risco.ts`, compartilhada com a
 * capacidade que a IA usa para consultar quem esfriou (IA 360 · wave 2): a tela e
 * o agente têm de dizer a MESMA coisa sobre o mesmo negócio.
 *
 * Client de sessão preserva RLS; organização e papel vêm de requireRole, nunca do body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { carregaRadarDeRisco, RADAR_MIN_HOURS_PADRAO } from "@/lib/leads/radar-de-risco";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  min_hours: z.coerce.number().int().min(0).max(2000).default(RADAR_MIN_HOURS_PADRAO),
});

export type { AtRiskLead } from "@/lib/leads/radar-de-risco";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "leads_at_risk" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { limit, min_hours } = parsed.data;

  try {
    const radar = await carregaRadarDeRisco(await createClient(), {
      organizationId: org.orgId,
      humanRole: org.role,
      limit,
      minHours: min_hours,
    });
    return ok(radar, { requestId });
  } catch {
    if (process.env.NODE_ENV === "development") {
      return ok(
        {
          items: [
            {
              id: "lead-risk-01",
              title: "Renato Alcantara - Indústria ABC",
              contact_id: "contact-01",
              contact_name: "Renato Alcantara",
              owner_user_id: "00000000-0000-4000-8000-000000000001",
              owner_kind: "user" as const,
              owner_agent_id: null,
              owner_agent_name: null,
              assignee_kind: "user" as const,
              last_activity_at: new Date(Date.now() - 3600000 * 48).toISOString(),
              hours_since_activity: 48,
              risk: "critico" as const,
              in_flight: false,
              next_followup_at: null,
              conversation_id: "conv-01",
              pipeline_id: "pipe-01",
            },
            {
              id: "lead-risk-02",
              title: "Juliana Martins - Clínica Bem Estar",
              contact_id: "contact-02",
              contact_name: "Dra. Juliana Martins",
              owner_user_id: "00000000-0000-4000-8000-000000000001",
              owner_kind: "ai" as const,
              owner_agent_id: "agent-sdr-01",
              owner_agent_name: "Agente SDR SomaFlow",
              assignee_kind: "ai" as const,
              last_activity_at: new Date(Date.now() - 3600000 * 20).toISOString(),
              hours_since_activity: 20,
              risk: "em_risco" as const,
              in_flight: true,
              next_followup_at: new Date(Date.now() + 3600000 * 4).toISOString(),
              conversation_id: "conv-02",
              pipeline_id: "pipe-01",
            },
          ],
          counts: { critico: 1, em_risco: 1, em_voo: 1 },
          total: 2,
          sem_proximo_passo: [],
          total_sem_proximo_passo: 0,
        },
        { requestId },
      );
    }
    return fail("internal_error", t("Falha ao carregar o radar."), 500, { requestId });
  }
}
