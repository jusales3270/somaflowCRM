import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { ProspectingClient } from "./_client";
import { ProspeccaoB2b } from "./_b2b/ProspeccaoB2b";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Prospecção" };

/**
 * Dois níveis de prospecção, lado a lado:
 *   - "Negócios locais (Google Maps)": o motor de sempre (`./_client.tsx`), intacto;
 *   - "Empresas B2B (CNPJ)": busca por CNAE, estado/cidade e porte (`./_b2b`).
 * O nível vem da URL (`?nivel=b2b`) — o padrão continua sendo o Google Maps.
 */
export default async function ProspectingPage({
  searchParams,
}: {
  searchParams: Promise<{ nivel?: string }>;
}) {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (org?.role !== "admin") redirect("/app/inbox");
  const { nivel } = await searchParams;
  const b2b = nivel === "b2b";
  const t = (texto: string) => traduzir(texto, user.idioma);
  const aba = (ativa: boolean) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
      ativa ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted"
    }`;
  return (
    <div className="flex flex-col gap-4">
      <nav
        aria-label={t("Nível de prospecção")}
        className="mx-4 mt-4 flex w-fit flex-wrap gap-1 rounded-xl border bg-surface p-1 md:mx-6"
      >
        <Link href="/app/prospecting" aria-current={b2b ? undefined : "page"} className={aba(!b2b)}>
          {t("Negócios locais (Google Maps)")}
        </Link>
        <Link href="/app/prospecting?nivel=b2b" aria-current={b2b ? "page" : undefined} className={aba(b2b)}>
          {t("Empresas B2B (CNPJ)")}
        </Link>
      </nav>
      {b2b ? (
        <div className="px-4 pb-8 md:px-6">
          <ProspeccaoB2b />
        </div>
      ) : (
        <ProspectingClient />
      )}
    </div>
  );
}
