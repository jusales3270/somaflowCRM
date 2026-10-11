import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { BudgetCard } from "@/components/ai/BudgetCard";
import { CustoDasLigacoesCard } from "@/components/ai/CustoDasLigacoesCard";
import { custoDasLigacoesSchema, type CustoDasLigacoes } from "@/lib/ai/usage/custo-das-ligacoes";
import { getBudgetStatus } from "@/lib/ai/budget/check";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { UsageDashboardClient } from "./_client";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function singleParam(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function AiUsagePage({ searchParams }: PageProps) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data: agentRows } = await supabase
    .from("ai_agents")
    .select("id, name, is_default")
    .eq("organization_id", activeOrg.orgId)
    .order("is_default", { ascending: false })
    .order("name", { ascending: true });

  const agents = (agentRows ?? []).map(
    (a: { id: string; name: string; is_default?: boolean | null }) => ({
      id: a.id,
      name: a.name,
    }),
  );

  const sp = await searchParams;
  const initial = {
    agent_id: singleParam(sp.agent_id),
    invocation_kind: singleParam(sp.invocation_kind),
    from: singleParam(sp.from),
    to: singleParam(sp.to),
  };

  const budget = await getBudgetStatus(activeOrg.orgId);
  const custoDasLigacoes = await lerCustoDasLigacoes(supabase, activeOrg.orgId);
  const isAdmin = ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Uso de IA", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Quanto a inteligência artificial custou, quantas vezes foi chamada, quantos turnos o agente fez, quanto demora uma chamada e quantas vezes precisou chamar uma pessoa — nos últimos 30 dias.",
            idioma,
          )}
        </p>
      </header>
      <BudgetCard initialData={budget} isAdmin={isAdmin} />
      {custoDasLigacoes ? <CustoDasLigacoesCard custo={custoDasLigacoes} idioma={idioma} /> : null}
      <UsageDashboardClient agents={agents} initial={initial} />
    </div>
  );
}

const JANELA_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * O custo das ligações de voz dos últimos 30 dias, somado e convertido em reais
 * no banco (`fn_custo_das_ligacoes`, security invoker — a RLS isola). `null`
 * quando não houve ligação, para o card não ocupar a tela de quem não usa voz,
 * e também quando a leitura falha: o card é informativo e não pode derrubar a
 * tela de uso.
 */
async function lerCustoDasLigacoes(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
): Promise<CustoDasLigacoes | null> {
  const agora = new Date();
  const { data, error } = await supabase.rpc("fn_custo_das_ligacoes", {
    p_org: orgId,
    p_desde: new Date(agora.getTime() - JANELA_MS).toISOString(),
    p_ate: agora.toISOString(),
    p_recentes: 10,
  });
  if (error) {
    logger.warn("ai_usage.custo_das_ligacoes_falhou", { error: error.message });
    return null;
  }
  const custo = custoDasLigacoesSchema.safeParse(data);
  if (!custo.success) {
    logger.warn("ai_usage.custo_das_ligacoes_formato", { issues: custo.error.issues.length });
    return null;
  }
  const { ligacoes, falhas } = custo.data.totais;
  return ligacoes + falhas > 0 ? custo.data : null;
}
