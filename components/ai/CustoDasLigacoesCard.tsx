import { Card } from "@/components/ui/card";
import {
  dataBr,
  formatarDolares,
  formatarReais,
  mediasDasLigacoes,
  type CustoDasLigacoes,
} from "@/lib/ai/usage/custo-das-ligacoes";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/**
 * Quanto as ligações de voz custaram, em REAIS.
 *
 * O resto da tela fala em dólar porque é a unidade que o produto mede
 * (`llm_calls.cost_cents`). Este card converte só a voz — o gasto mais caro por
 * minuto, e o que o dono da operação compara com o preço de uma ligação — e
 * converte cada ligação pela PTAX do dia em que ela aconteceu
 * (`fn_custo_das_ligacoes`), nunca pela de hoje: o custo de setembro não muda
 * quando o dólar muda em outubro.
 *
 * Componente de servidor: recebe o resultado já agregado no banco e o idioma.
 */
export function CustoDasLigacoesCard({
  custo,
  idioma,
}: {
  custo: CustoDasLigacoes;
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const tag = tagDeIdioma(idioma);
  const { totais, recentes, cotacao_atual: cotacao } = custo;
  const medias = mediasDasLigacoes(custo);
  const semReais = !cotacao;

  return (
    <Card className="p-4" data-testid="custo-das-ligacoes">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{t("Ligações de voz")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t(
            "Quanto as ligações atendidas pelo agente de voz custaram nos últimos 30 dias. Cada ligação é convertida em reais pela cotação do dólar (PTAX do Banco Central) do dia em que aconteceu.",
          )}
        </p>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Numero
          rotulo={t("Custo em reais")}
          valor={semReais ? "—" : formatarReais(totais.custo_brl_cents, tag)}
          detalhe={formatarDolares(totais.custo_usd_cents, tag)}
          testid="custo-total-brl"
        />
        <Numero
          rotulo={t("Ligações")}
          valor={totais.ligacoes.toLocaleString(tag)}
          detalhe={`${medias.minutos.toLocaleString(tag, { maximumFractionDigits: 1 })} ${t("min no total")}`}
        />
        <Numero
          rotulo={t("Média por ligação")}
          valor={medias.porLigacaoBrlCents === null ? "—" : formatarReais(medias.porLigacaoBrlCents, tag)}
        />
        <Numero
          rotulo={t("Custo por minuto")}
          valor={medias.porMinutoBrlCents === null ? "—" : formatarReais(medias.porMinutoBrlCents, tag)}
          testid="custo-por-minuto-brl"
        />
      </dl>

      {totais.sem_preco > 0 ? (
        <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200">
          {totais.sem_preco.toLocaleString(tag)}{" "}
          {t(
            "ligação(ões) usaram um modelo de voz sem tarifa conhecida e ficaram fora do total — o gasto real é maior que o mostrado.",
          )}
        </p>
      ) : null}
      {semReais ? (
        <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200">
          {t(
            "A cotação do dólar ainda não foi obtida do Banco Central. O total em reais aparece depois da próxima busca automática, que roda todo dia às 13h40 de Brasília.",
          )}
        </p>
      ) : null}

      {recentes.length > 0 ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-xs">
            <caption className="sr-only">{t("Ligações mais recentes")}</caption>
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th className="py-1.5 pr-3 font-medium">{t("Quando")}</th>
                <th className="py-1.5 pr-3 font-medium">{t("Duração")}</th>
                <th className="py-1.5 pr-3 font-medium">{t("Modelo")}</th>
                <th className="py-1.5 pr-3 text-right font-medium">{t("Dólar")}</th>
                <th className="py-1.5 pr-3 text-right font-medium">{t("Cotação")}</th>
                <th className="py-1.5 text-right font-medium">{t("Reais")}</th>
              </tr>
            </thead>
            <tbody>
              {recentes.map((r) => (
                <tr key={`${r.created_at}-${r.model}`} className="border-b last:border-0">
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    {new Date(r.created_at).toLocaleString(tag, {
                      timeZone: "America/Sao_Paulo",
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {r.status === "erro" ? (
                      <span className="ml-1 text-destructive">· {t("não conectou")}</span>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">{duracao(r.duracao_ms)}</td>
                  <td className="py-1.5 pr-3 font-mono">{r.model}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {r.custo_usd_cents === null ? "—" : formatarDolares(r.custo_usd_cents, tag)}
                  </td>
                  <td
                    className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground"
                    title={r.cotacao_data ? `PTAX ${dataBr(r.cotacao_data)}` : undefined}
                  >
                    {r.cotacao === null
                      ? "—"
                      : r.cotacao.toLocaleString(tag, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {r.custo_brl_cents === null ? "—" : formatarReais(r.custo_brl_cents, tag)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {cotacao ? (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="cotacao-atual">
          {t("Cotação mais recente")}:{" "}
          {cotacao.venda.toLocaleString(tag, {
            style: "currency",
            currency: "BRL",
            minimumFractionDigits: 4,
            maximumFractionDigits: 4,
          })}{" "}
          {t("por dólar")} · PTAX {dataBr(cotacao.data)} · {t("Banco Central do Brasil")}
        </p>
      ) : null}
    </Card>
  );
}

function Numero({
  rotulo,
  valor,
  detalhe,
  testid,
}: {
  rotulo: string;
  valor: string;
  detalhe?: string;
  testid?: string;
}) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-xs text-muted-foreground">{rotulo}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums" data-testid={testid}>
        {valor}
      </dd>
      {detalhe ? <dd className="text-xs text-muted-foreground tabular-nums">{detalhe}</dd> : null}
    </div>
  );
}

function duracao(ms: number | null): string {
  if (ms === null || ms <= 0) return "—";
  const total = Math.round(ms / 1000);
  const min = Math.floor(total / 60);
  const seg = total % 60;
  return `${min}:${String(seg).padStart(2, "0")}`;
}
