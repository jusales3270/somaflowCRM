import { InterfaceRefresh } from "@/hooks/auth/InterfaceRefresh";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isMfaEnrolled, loadAuthUser, requiresMfa, resolveActiveOrg } from "@/lib/auth/server";
import { DEFAULT_VISIBILITY_MODE, type VisibilityMode } from "@/lib/auth/types";
import { AuthProvider } from "@/hooks/auth/AuthProvider";
import { AppShell } from "./_components/AppShell";
import { EstiloDaMarcaDaOrganizacao } from "./_components/EstiloDaMarcaDaOrganizacao";
import { MfaEnrollGate } from "@/components/auth/MfaEnrollGate";
import { cssDaMarca, ESCOPO_DA_ORGANIZACAO } from "@/lib/branding/css";
import { marcaDaInstalacao } from "@/lib/branding/instalacao";
import { resolverMarcaDaOrganizacao } from "@/lib/branding/organizacao";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ImpersonateBanner,
} from "@/components/app/ImpersonateBanner";
import { ConexaoCaidaBanner } from "@/components/app/ConexaoCaidaBanner";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { listarConexoesCaidas, type ConexaoCaida } from "@/lib/channels/health";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await loadAuthUser();
  if (!user) redirect("/login");

  let activeOrg = await resolveActiveOrg(user);

  /**
   * A cor desta organização, serializada, ou `null` quando ela não tem uma.
   *
   * Resolvida no MESMO `settings` que o gate de onboarding logo abaixo já lê —
   * zero consulta nova. A ordem das camadas (organização acima, instalação no
   * meio, arquivo de instalação embaixo) mora em `lib/branding/organizacao.ts`,
   * e não aqui: a precedência é regra do produto, não detalhe deste layout.
   */
  let cssDaOrganizacao: string | null = null;

  // EPIC-02: gate /app/* on completed onboarding.
  // EPIC-11: gate /app/* on org not being suspended (S-11.08).
    try {
      const admin = createAdminClient();
      const { data: orgRow } = await admin
        .from("organizations")
        .select("onboarded_at, status, settings")
        .eq("id", activeOrg.orgId)
        .maybeSingle();
      if (orgRow && !orgRow.onboarded_at && !user.support) redirect("/onboarding");
      if (orgRow?.status === "suspended") redirect("/account-suspended");
      // G4-02: expõe visibility_mode ao client (inbox decide visões visíveis).
      // Fonte confiável (admin client, org do cookie validado) — nunca do body.
      const mode = (orgRow?.settings as { visibility_mode?: VisibilityMode } | null)
        ?.visibility_mode;
      activeOrg = { ...activeOrg, visibility_mode: mode ?? DEFAULT_VISIBILITY_MODE };

      const marca = resolverMarcaDaOrganizacao(
        orgRow?.settings ?? null,
        await marcaDaInstalacao(),
        env,
      );

      if (marca.origens.cor === "organizacao") {
        cssDaOrganizacao = cssDaMarca(marca.cor, ESCOPO_DA_ORGANIZACAO).css;
      }

      const marcaDoTenant = {
        ...(marca.origens.nome === "organizacao" ? { nome: marca.name } : {}),
        ...(marca.origens.logoUrl === "organizacao" && marca.logoUrl !== null
          ? { logoUrl: marca.logoUrl }
          : {}),
      };
      if (Object.keys(marcaDoTenant).length > 0) {
        activeOrg = { ...activeOrg, marca: marcaDoTenant };
      }
    } catch {
      // In dev or when database is not connected, keep running smoothly
    }
  }

  let conexoesCaidas: ConexaoCaida[] = [];
  try {
    conexoesCaidas = activeOrg
      ? await listarConexoesCaidas(createAdminClient(), activeOrg.orgId)
      : [];
  } catch {
    conexoesCaidas = [];
  }

  // Read sidebar collapsed state SSR to avoid flash.
  const store = await cookies();
  const collapsed = store.get("sidebar_collapsed")?.value === "1";

  const impersonating = user.support ? {
    tenantId: user.support.organization_id, tenantName: user.support.name,
    expiresAt: user.support.expires_at, accessMode: user.support.access_mode,
  } : null;

  let enrolled = false;
  let needsMfaGate = false;
  try {
    enrolled = await isMfaEnrolled();
    if (process.env.NODE_ENV !== "development") {
      needsMfaGate = await requiresMfa(
        activeOrg?.role,
        user.is_platform_admin,
        user.id,
        activeOrg?.orgId,
      );
    }
  } catch {
    enrolled = false;
    needsMfaGate = false;
  }
  const shell = <AppShell sidebarCollapsed={collapsed}>{children}</AppShell>;

  return (
    // O idioma envolve a árvore inteira e recebe o código PRONTO — ele não
    // pergunta quem está logado. Ver `lib/i18n/IdiomaProvider`: foi o
    // acoplamento com a autenticação que derrubou 32 casos.
    <IdiomaProvider locale={user.idioma}>
    <AuthProvider user={user} activeOrg={activeOrg}>
      <InterfaceRefresh userId={user.id} org={activeOrg} support={!!user.support} />
      {/*
        O MARCADOR da marca da organização — o elemento cuja existência define o
        escopo `body:has([data-marca-org])` (lib/branding/css.ts).

        `contents` não gera caixa: no box tree os filhos continuam sendo filhos
        diretos do `<body>`, então nada de layout, `position` ou `flex` muda. O
        que este elemento existe para fazer é EXISTIR — e sumir junto com esta
        subárvore quando o logout navega para `/login`.

        Envolve TUDO, e não a div do `AppShell`, porque aquela div é irmã dos dois
        banners e é SUBSTITUÍDA quando o `MfaEnrollGate` bloqueia (ele renderiza
        um `fixed inset-0` no lugar dos children). O admin de tenant recém-criado
        veria a tela de cadastro de MFA — a PRIMEIRA tela dele — com a cor da
        instalação, e depois o resto do produto com a dele.
      */}
      <div data-marca-org="" className="contents">
        <EstiloDaMarcaDaOrganizacao css={cssDaOrganizacao} />
        <ImpersonateBanner impersonating={impersonating} />
        <ConexaoCaidaBanner caidas={conexoesCaidas} />
        {needsMfaGate ? (
          // Gate always mounted for MFA-required roles; it latches the blocking
          // decision client-side so the enroll Server Action's revalidation
          // can't tear down the recovery-codes screen mid-flow.
          <MfaEnrollGate enrolled={enrolled}>{shell}</MfaEnrollGate>
        ) : (
          shell
        )}
      </div>
    </AuthProvider>
    </IdiomaProvider>
  );
}
