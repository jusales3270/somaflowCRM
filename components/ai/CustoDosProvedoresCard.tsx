import { Card } from "@/components/ui/card";
import { formatarDolares, formatarReais } from "@/lib/ai/usage/custo-das-ligacoes";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { CustoDosProvedores } from "@/lib/prospecting/b2b/custos";

/**
 * Quanto a prospecção B2B gastou FORA da IA: a CNPJá (créditos, ao valor do
 * crédito que a organização informou) e o Treg (US$ por consulta, convertido pela
 * PTAX do dia de cada consulta — `fn_custo_dos_provedores`).
 *
 * Informativo e separado do teto de IA de propósito: gasto de prospecção não pode
 * parar as respostas da IA no WhatsApp. A nota do Jev é IA e já aparece no resto
 * desta tela (`llm_calls`). Componente de servidor.
 */
export function CustoDosProvedoresCard({ custo, idioma }: { custo: CustoDosProvedores; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const tag = tagDeIdioma(idioma);
  const cnpja = custo.provedores.find((p) => p.provider === "cnpja");
  const treg = custo.provedores.find((p) => p.provider === "treg");
  const NOME: Record<string, string> = {
    busca: t("buscas"),
    carregar_mais: t("carregar mais"),
    email: t("e-mails"),
    celular: t("celulares"),
  };
  const operacoes = (o: Record<string, number> | null) =>
    Object.entries(o ?? {})
      .map(([k, n]) => `${n.toLocaleString(tag)} ${NOME[k] ?? k}`)
      .join(" · ");

  return (
    <Card className="p-4" data-testid="custo-dos-provedores">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{t("Prospecção B2B: provedores de dados")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t(
            "Quanto a busca de empresas (CNPJá) e de decisores (Treg) custou nos últimos 30 dias. Fica fora do teto de IA: não para as respostas da IA. A nota do Jev é IA e entra no resto desta tela.",
          )}
        </p>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-lg border p-3">
          <dt className="text-xs text-muted-foreground">{t("Total em reais")}</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums" data-testid="custo-provedores-total">
            {formatarReais(custo.total_brl_cents, tag)}
          </dd>
        </div>
        <div className="rounded-lg border p-3">
          <dt className="text-xs text-muted-foreground">{t("CNPJá (empresas)")}</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums" data-testid="custo-cnpja">
            {cnpja ? formatarReais(cnpja.custo_brl_cents, tag) : "—"}
          </dd>
          {cnpja ? (
            <dd className="text-xs text-muted-foreground tabular-nums">
              {cnpja.unidades.toLocaleString(tag)} {cnpja.unidades === 1 ? t("crédito") : t("créditos")} ·{" "}
              {operacoes(cnpja.operacoes)}
            </dd>
          ) : null}
        </div>
        <div className="rounded-lg border p-3">
          <dt className="text-xs text-muted-foreground">{t("Treg (decisores)")}</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums" data-testid="custo-treg">
            {treg ? formatarReais(treg.custo_brl_cents, tag) : "—"}
          </dd>
          {treg ? (
            <dd className="text-xs text-muted-foreground tabular-nums">
              {formatarDolares(treg.custo_usd_micro / 10_000, tag)} · {treg.chamadas.toLocaleString(tag)}{" "}
              {treg.chamadas === 1 ? t("consulta cobrada") : t("consultas cobradas")}
            </dd>
          ) : null}
        </div>
      </dl>

      {treg && treg.sem_cotacao > 0 ? (
        <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200">
          {t("Ainda não há cotação do dólar para converter parte das consultas do Treg; o total em reais está menor que o real.")}
        </p>
      ) : null}
      {custo.cotacao_atual ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("Cotação do dólar mais recente (PTAX):")}{" "}
          {custo.cotacao_atual.venda.toLocaleString(tag, { style: "currency", currency: "BRL", maximumFractionDigits: 4 })}
        </p>
      ) : null}
    </Card>
  );
}
