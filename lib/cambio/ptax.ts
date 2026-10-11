/**
 * A COTAÇÃO DO DÓLAR (PTAX) DO BANCO CENTRAL — para converter em reais o gasto
 * de IA, que o produto mede em centavos de dólar.
 *
 * ═══ POR QUE A PTAX ═══
 *
 * É a taxa oficial que o Banco Central publica todo dia útil (perto das 13h de
 * Brasília) e a que contratos e faturas em dólar costumam usar. O endpoint é
 * público e sem chave — nenhuma variável nova na instalação.
 *
 * ═══ POR QUE UM PERÍODO, E NÃO SÓ O DIA ═══
 *
 * Fim de semana e feriado não têm cotação, e um dia em que o servidor esteve
 * fora não a buscou. Pedir sempre os últimos dias faz a rodada seguinte
 * preencher sozinha o que faltou — a mesma linha regravada não muda nada.
 *
 * Puro, exceto `buscarPtaxDoPeriodo`, que recebe o `fetch` por parâmetro.
 */

export const ENDPOINT_PTAX =
  "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/" +
  "CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)";

export interface CotacaoPtax {
  /** Dia da cotação, `AAAA-MM-DD` (calendário de Brasília). */
  data: string;
  /** Reais por dólar, venda — a que se paga para COMPRAR dólar. */
  venda: number;
  compra: number;
}

/** `AAAA-MM-DD` → `'MM-DD-AAAA'`, o formato que o OData do BCB exige. */
function paraOData(dia: string): string {
  const [a, m, d] = dia.split("-");
  return `'${m}-${d}-${a}'`;
}

export function urlDoPeriodo(inicio: string, fim: string): string {
  const q = new URLSearchParams({
    "@dataInicial": paraOData(inicio),
    "@dataFinalCotacao": paraOData(fim),
    $format: "json",
    $select: "cotacaoCompra,cotacaoVenda,dataHoraCotacao",
  });
  return `${ENDPOINT_PTAX}?${q.toString()}`;
}

function positivo(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Traduz a resposta do BCB. Linha fora do formato é DESCARTADA, nunca vira
 * zero: uma cotação 0 converteria a conta inteira do dia em R$ 0,00. Se o
 * mesmo dia vier repetido, fica a última (o BCB lista em ordem cronológica).
 */
export function traduzirRespostaPtax(json: unknown): CotacaoPtax[] {
  const valor = (json as { value?: unknown } | null)?.value;
  if (!Array.isArray(valor)) {
    throw new Error("ptax_formato_inesperado — a resposta não trouxe `value` como lista");
  }
  const porDia = new Map<string, CotacaoPtax>();
  for (const linha of valor as Array<Record<string, unknown>>) {
    const venda = positivo(linha?.cotacaoVenda);
    const compra = positivo(linha?.cotacaoCompra);
    const quando = typeof linha?.dataHoraCotacao === "string" ? linha.dataHoraCotacao : "";
    const data = /^\d{4}-\d{2}-\d{2}/.exec(quando)?.[0];
    if (!venda || !compra || !data) continue;
    porDia.set(data, { data, venda, compra });
  }
  return [...porDia.values()].sort((a, b) => a.data.localeCompare(b.data));
}

/** O dia de hoje (ou `deslocamentoDias` antes) no calendário de Brasília. */
export function diaEmBrasilia(agora: Date, deslocamentoDias = 0): string {
  const alvo = new Date(agora.getTime() - deslocamentoDias * 86_400_000);
  // `en-CA` formata como AAAA-MM-DD.
  return alvo.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

export async function buscarPtaxDoPeriodo(
  inicio: string,
  fim: string,
  buscar: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<CotacaoPtax[]> {
  const res = await buscar(urlDoPeriodo(inicio, fim), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`ptax_status_${res.status}`);
  return traduzirRespostaPtax(await res.json());
}
