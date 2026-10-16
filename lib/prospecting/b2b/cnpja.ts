/**
 * Cliente da CNPJá — a busca de estabelecimentos por filtro (CNAE, UF, município,
 * porte, situação). É o que a prospecção B2B usa para achar empresas com
 * faturamento acima de R$ 4,8 mi/ano (porte "Demais" da Receita).
 *
 * Contrato conferido no SDK oficial (github.com/cnpja/sdk-nodejs):
 *   - base `https://api.cnpja.com`, cabeçalho `Authorization: <chave>`;
 *   - `GET /office?<filtros>` devolve `{ next, limit, count, records[] }`; a página
 *     seguinte é `GET /office?token=<next>` (o token é exclusivo: vai sozinho);
 *   - filtros com ponto (`mainActivity.id.in`, `address.state.in`…), listas
 *     separadas por vírgula; `limit` de 1 a 100;
 *   - custo: 1 crédito a cada 10 estabelecimentos devolvidos;
 *   - `GET /credit` devolve o saldo `{ perpetual, transient }` — é o "Testar".
 *
 * A saída de rede passa por `allowlistedFetch` com o host da base configurada.
 */
import { z } from "zod";

import { allowlistedFetch } from "@/lib/agent-engine/edge/egress";
import { env } from "@/lib/env";
import { PORTES, type EmpresaB2b, type FiltrosB2b } from "./schema";

export const BASE_PADRAO_CNPJA = "https://api.cnpja.com";
const TIMEOUT_MS = 25_000;
export const POR_PAGINA = 100;

export class ErroDaCnpja extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly motivo: "chave" | "saldo" | "limite" | "indisponivel" | "resposta",
  ) {
    super(message);
    this.name = "ErroDaCnpja";
  }
}

export function baseDaCnpja(): string {
  const configurada = env.CNPJA_API_BASE_URL.trim();
  return (configurada || BASE_PADRAO_CNPJA).replace(/\/+$/, "");
}

/** Filtros da tela → parâmetros da CNPJá. Puro. */
export function montarConsulta(f: FiltrosB2b, limite = POR_PAGINA): URLSearchParams {
  const q = new URLSearchParams();
  q.set("limit", String(Math.min(POR_PAGINA, Math.max(1, limite))));
  const cnaes = f.cnaes.map((c) => String(Number(c))).join(",");
  q.set(f.tipo_cnae === "principal" ? "mainActivity.id.in" : "activities.id.in", cnaes);
  if (f.municipios.length) q.set("address.municipality.in", f.municipios.join(","));
  else if (f.ufs.length) q.set("address.state.in", f.ufs.join(","));
  q.set("company.size.id.in", f.portes.join(","));
  if (f.so_ativas) q.set("status.id.in", "2");
  if (f.so_matriz) q.set("head.eq", "true");
  if (f.nao_optante_simples) q.set("company.simples.optant.eq", "false");
  if (f.capital_minimo !== null) q.set("company.equity.gte", String(f.capital_minimo));
  if (f.exige_telefone) q.set("phones.ex", "true");
  if (f.exige_email) q.set("emails.ex", "true");
  return q;
}

/** Créditos que a busca pode consumir, no máximo — o que a tela mostra antes. */
export function creditosEstimados(maxResultados: number): number {
  return Math.ceil(maxResultados / 10);
}

const atividade = z.object({ id: z.coerce.number(), text: z.string().optional() }).passthrough();
const registro = z
  .object({
    taxId: z.string(),
    alias: z.string().nullable().optional(),
    founded: z.string().nullable().optional(),
    head: z.boolean().optional(),
    status: z.object({ id: z.number().optional(), text: z.string().optional() }).passthrough().optional(),
    company: z
      .object({
        name: z.string().optional(),
        equity: z.coerce.number().nullable().optional(),
        nature: z.object({ text: z.string().optional() }).passthrough().nullable().optional(),
        size: z
          .object({ id: z.number().optional(), acronym: z.string().optional(), text: z.string().optional() })
          .passthrough()
          .nullable()
          .optional(),
        simples: z.object({ optant: z.boolean().optional() }).passthrough().nullable().optional(),
      })
      .passthrough()
      .optional(),
    address: z
      .object({
        municipality: z.coerce.number().nullable().optional(),
        city: z.string().nullable().optional(),
        state: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    phones: z
      .array(
        z.object({ type: z.string().optional(), area: z.string().optional(), number: z.string().optional() }).passthrough(),
      )
      .nullable()
      .optional(),
    emails: z
      .array(z.object({ ownership: z.string().optional(), address: z.string().optional(), domain: z.string().optional() }).passthrough())
      .nullable()
      .optional(),
    mainActivity: atividade.nullable().optional(),
    sideActivities: z.array(atividade).nullable().optional(),
  })
  .passthrough();

const pagina = z.object({
  next: z.string().nullable().optional(),
  count: z.coerce.number().optional(),
  records: z.array(z.unknown()),
});

function cnae7(id: number | undefined): string | null {
  if (!id || !Number.isFinite(id)) return null;
  return String(id).padStart(7, "0");
}

/**
 * Registro da CNPJá → empresa. Minimização (LGPD): só e-mail CORPORATIVO entra —
 * o da contabilidade não é da empresa, e o pessoal é de uma pessoa física.
 * Devolve `null` para registro sem CNPJ válido.
 */
export function normalizarEstabelecimento(bruto: unknown): EmpresaB2b | null {
  const r = registro.safeParse(bruto);
  if (!r.success) return null;
  const e = r.data;
  const cnpj = e.taxId.replace(/\D/g, "");
  if (cnpj.length !== 14) return null;
  const emails = (e.emails ?? [])
    .filter((m) => (m.ownership ?? "CORPORATE").toUpperCase() === "CORPORATE")
    .map((m) => (m.address ?? "").trim().toLowerCase())
    .filter((m) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m));
  // Só sobra e-mail que a própria CNPJá marcou como CORPORATIVO (o pessoal e o
  // da contabilidade saíram acima): o domínio dele é o da empresa.
  const dominio = emails[0]?.split("@")[1] ?? null;
  const telefones = (e.phones ?? [])
    .map((t) => ({
      numero: `${(t.area ?? "").replace(/\D/g, "")}${(t.number ?? "").replace(/\D/g, "")}`,
      tipo: (t.type ?? "").toUpperCase() === "MOBILE" ? ("celular" as const) : ("fixo" as const),
    }))
    .filter((t) => t.numero.length >= 10);
  const porteId = e.company?.size?.id ?? null;
  return {
    cnpj,
    razao_social: e.company?.name?.trim() || e.alias?.trim() || cnpj,
    nome_fantasia: e.alias?.trim() || null,
    cnae_principal: cnae7(e.mainActivity?.id),
    cnae_principal_descricao: e.mainActivity?.text ?? null,
    cnaes_secundarios: (e.sideActivities ?? []).map((a) => cnae7(a.id)).filter((c): c is string => !!c),
    porte_id: porteId,
    porte:
      e.company?.size?.acronym ??
      (porteId === PORTES.DEMAIS ? "DEMAIS" : porteId === PORTES.EPP ? "EPP" : porteId === PORTES.ME ? "ME" : null),
    capital_social: e.company?.equity ?? null,
    simples_optante: e.company?.simples?.optant ?? null,
    natureza_juridica: e.company?.nature?.text ?? null,
    uf: e.address?.state ?? null,
    municipio_ibge: e.address?.municipality ?? null,
    cidade: e.address?.city ?? null,
    aberta_em: e.founded ?? null,
    situacao: e.status?.text ?? null,
    telefones,
    emails,
    dominio,
  };
}

async function chamar(chave: string, caminho: string, buscar?: typeof fetch): Promise<unknown> {
  const base = baseDaCnpja();
  let res: Response;
  try {
    res = await allowlistedFetch(
      `${base}${caminho}`,
      { headers: { Authorization: chave, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) },
      { allowlist: new Set([new URL(base).host]), fetchImpl: buscar },
    );
  } catch {
    throw new ErroDaCnpja("A CNPJá não respondeu. Tente de novo em instantes.", 502, "indisponivel");
  }
  if (res.status === 401 || res.status === 403)
    throw new ErroDaCnpja("A chave da CNPJá foi recusada. Confira e salve de novo.", 422, "chave");
  if (res.status === 402)
    throw new ErroDaCnpja("Sem créditos na CNPJá. Recarregue o saldo e tente de novo.", 402, "saldo");
  if (res.status === 429)
    throw new ErroDaCnpja("A CNPJá limitou as consultas por minuto. Aguarde um pouco.", 429, "limite");
  if (!res.ok) throw new ErroDaCnpja(`A CNPJá respondeu com erro (${res.status}).`, 502, "indisponivel");
  try {
    return await res.json();
  } catch {
    throw new ErroDaCnpja("A CNPJá devolveu uma resposta ilegível.", 502, "resposta");
  }
}

export async function saldoDaCnpja(
  chave: string,
  buscar?: typeof fetch,
): Promise<{ creditos: number }> {
  const corpo = z
    .object({ perpetual: z.coerce.number().default(0), transient: z.coerce.number().default(0) })
    .passthrough()
    .safeParse(await chamar(chave, "/credit", buscar));
  if (!corpo.success) throw new ErroDaCnpja("A CNPJá devolveu um saldo ilegível.", 502, "resposta");
  return { creditos: corpo.data.perpetual + corpo.data.transient };
}

export interface PaginaDeEmpresas {
  empresas: EmpresaB2b[];
  /** Registros que vieram e foram descartados por formato. */
  descartados: number;
  recebidos: number;
  proximo: string | null;
  total: number | null;
}

/** Uma página: pelos filtros (primeira) ou pelo token (seguintes). */
export async function buscarPagina(
  chave: string,
  entrada: { filtros: FiltrosB2b; limite?: number } | { token: string },
  buscar?: typeof fetch,
): Promise<PaginaDeEmpresas> {
  const consulta =
    "token" in entrada
      ? new URLSearchParams({ token: entrada.token })
      : montarConsulta(entrada.filtros, entrada.limite);
  const corpo = pagina.safeParse(await chamar(chave, `/office?${consulta.toString()}`, buscar));
  if (!corpo.success) throw new ErroDaCnpja("A CNPJá devolveu uma página ilegível.", 502, "resposta");
  const empresas: EmpresaB2b[] = [];
  for (const bruto of corpo.data.records) {
    const empresa = normalizarEstabelecimento(bruto);
    if (empresa) empresas.push(empresa);
  }
  return {
    empresas,
    descartados: corpo.data.records.length - empresas.length,
    recebidos: corpo.data.records.length,
    proximo: corpo.data.next || null,
    total: corpo.data.count ?? null,
  };
}
