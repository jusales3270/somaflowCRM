/**
 * Cliente do Treg para os DECISORES das empresas escolhidas na lista B2B.
 *
 * A fonte de pessoas é a APOLLO, chamada direto pelo Treg (não a busca "roteada"
 * `treg.people.search`). Medido com empresas reais de Indaiatuba (16/10/2026):
 *   - `treg.people.search` (cascata de 25 provedores) IGNORA o cargo e, sem domínio,
 *     devolve gente de OUTRAS empresas da cidade — LinkedIns que não batem;
 *   - `apollo.people.search` filtra por empresa (domínio ou id Apollo) e por
 *     senioridade NA BASE, a pessoa vem ligada ao cadastro da empresa, e é GRÁTIS
 *     (não devolve contato): achou decisor em 17 de 34 empresas, todas certas;
 *   - `apollo.people.enrich` pelo id (US$ 0,026) devolve nome completo, cargo,
 *     LinkedIn, e-mail com `email_status` e cidade;
 *   - `apollo.companies.search` pelo nome (US$ 0,026 por PÁGINA) acha a empresa que
 *     não tem domínio na Receita — ambígua, quem escolhe é `./decisores.ts`.
 * O e-mail que a Apollo não tiver sai por `treg.people.email.find` (com verificação),
 * e o celular, só quando pedido, por `treg.people.phone.find` (o da Apollo exige chave
 * própria da Apollo).
 *
 * Contrato (catálogo público do Treg): `POST https://treg.to/call/<id>` com
 * `X-Treg-Token`; os endpoints da Apollo recebem os filtros na QUERY (arrays como
 * `campo[]=valor`) e devolvem a resposta da Apollo crua; os roteados (`treg.*`)
 * recebem JSON e devolvem `{ output, raw, _treg }`. Custo em `X-Treg-Cost-Micro`
 * (micro-US$), id em `X-Treg-Call-Id`, teto da chamada em `X-Treg-Route-Max-Cost`
 * (acima dele: 402 `route_max_cost`, nada cobrado), `Idempotency-Key` contra pagar
 * duas vezes, `X-Treg-Meta` com a organização. 402 sem `route_max_cost` = sem saldo.
 */
import { allowlistedFetch } from "@/lib/agent-engine/edge/egress";
import { env } from "@/lib/env";

export const BASE_PADRAO_TREG = "https://treg.to";
/** Alguns provedores demoram; a Apollo responde em ~1 s. */
const TIMEOUT_MS = 90_000;

export class ErroDoTreg extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly motivo: "chave" | "saldo" | "teto" | "limite" | "recusada" | "indisponivel" | "resposta",
  ) {
    super(message);
    this.name = "ErroDoTreg";
  }
}

export function baseDoTreg(): string {
  const configurada = env.TREG_API_BASE_URL.trim();
  return (configurada || BASE_PADRAO_TREG).replace(/\/+$/, "");
}

export interface RespostaDoTreg<T> {
  saida: T;
  custoMicro: number;
  callId: string | null;
  servidoPor: string | null;
  /** O bloco `_treg` da resposta roteada (verificação, provedores tentados). */
  meta: Record<string, unknown> | null;
}

export interface Opcoes {
  /** Teto em micro-US$ para ESTA chamada (vira `X-Treg-Route-Max-Cost`). */
  tetoMicro: number;
  organizacao: string;
  idempotencia: string;
  verificar?: boolean;
  buscar?: typeof fetch;
}

type Consulta = Record<string, string | number | boolean | Array<string> | null | undefined>;

/** `{ a: ["x","y"], b: 1 }` → `a[]=x&a[]=y&b=1` (o formato dos endpoints da Apollo). */
export function consultaDaApollo(c: Consulta): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(c)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) q.append(`${k}[]`, x);
    else q.append(k, String(v));
  }
  return q.toString();
}

async function chamar(
  chave: string,
  endpoint: string,
  entrada: { corpo: object } | { consulta: Consulta },
  op: Opcoes,
): Promise<RespostaDoTreg<unknown>> {
  const base = baseDoTreg();
  const roteado = endpoint.startsWith("treg.");
  const headers: Record<string, string> = {
    "X-Treg-Token": chave,
    Accept: "application/json",
    "X-Treg-Route-Max-Cost": (Math.max(op.tetoMicro, 0) / 1_000_000).toFixed(6),
    "X-Treg-Meta": `customer=${op.organizacao.replace(/[^A-Za-z0-9._:-]/g, "")}, feature=prospeccao-b2b`,
    "Idempotency-Key": op.idempotencia,
  };
  if (op.verificar) headers["X-Treg-Route-Verify"] = "true";
  const url =
    "consulta" in entrada ? `${base}/call/${endpoint}?${consultaDaApollo(entrada.consulta)}` : `${base}/call/${endpoint}`;
  const init: RequestInit = { method: "POST", headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if ("corpo" in entrada) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(entrada.corpo);
  }
  let res: Response;
  try {
    res = await allowlistedFetch(url, init, { allowlist: new Set([new URL(base).host]), fetchImpl: op.buscar });
  } catch {
    throw new ErroDoTreg("O Treg não respondeu. Tente de novo em instantes.", 502, "indisponivel");
  }
  const custoMicro = Math.max(0, Number(res.headers.get("X-Treg-Cost-Micro") ?? 0) || 0);
  const callId = res.headers.get("X-Treg-Call-Id");
  const servidoPor = res.headers.get("X-Treg-Served-By");
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.status === 401 || res.status === 403)
    throw new ErroDoTreg("O token do Treg foi recusado. Confira e salve de novo.", 422, "chave");
  if (res.status === 402) {
    const erro = JSON.stringify(json ?? "");
    if (erro.includes("route_max_cost")) throw new ErroDoTreg("Esta consulta custaria mais que o teto.", 402, "teto");
    throw new ErroDoTreg("Sem saldo no Treg. Recarregue o saldo e continue.", 402, "saldo");
  }
  // 409: a mesma chave de idempotência ainda roda no Treg (o nosso relógio estourou
  // antes do dele) — a retentativa recebe a resposta, sem pagar de novo.
  if ([429, 503, 409, 410, 202].includes(res.status))
    throw new ErroDoTreg("O Treg está ocupado agora. Tente de novo em instantes.", 429, "limite");
  // 422: recusada antes de sair (filtro estrito, parâmetro da Apollo); nada é
  // cobrado e repetir a mesma consulta não muda o resultado.
  if (res.status === 422) throw new ErroDoTreg("O Treg recusou a consulta desta empresa.", 422, "recusada");
  if (!res.ok) throw new ErroDoTreg(`O Treg respondeu com erro (${res.status}).`, 502, "indisponivel");
  if (json === null || typeof json !== "object") throw new ErroDoTreg("O Treg devolveu uma resposta ilegível.", 502, "resposta");
  const meta = ((json as { _treg?: unknown })._treg ?? null) as Record<string, unknown> | null;
  const saida = roteado ? (json as { output?: unknown }).output : json;
  if (saida === undefined) throw new ErroDoTreg("O Treg devolveu uma resposta ilegível.", 502, "resposta");
  return { saida, custoMicro, callId, servidoPor: servidoPor ?? (typeof meta?.served_by === "string" ? meta.served_by : null), meta };
}

/** Confere o token sem gastar: `GET /tools` só responde 200 a token válido. */
export async function testarTokenDoTreg(chave: string, buscar?: typeof fetch): Promise<void> {
  const base = baseDoTreg();
  let res: Response;
  try {
    res = await allowlistedFetch(
      `${base}/tools`,
      { headers: { "X-Treg-Token": chave, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) },
      { allowlist: new Set([new URL(base).host]), fetchImpl: buscar },
    );
  } catch {
    throw new ErroDoTreg("O Treg não respondeu. Tente de novo em instantes.", 502, "indisponivel");
  }
  if (res.status === 401 || res.status === 403)
    throw new ErroDoTreg("O token do Treg foi recusado. Confira e salve de novo.", 422, "chave");
  if (res.status === 400)
    throw new ErroDoTreg(
      "Este token do Treg é pessoal e não diz de qual equipe é. Gere um token de equipe (treg org agent-new) e salve de novo.",
      422,
      "chave",
    );
  if (!res.ok) throw new ErroDoTreg(`O Treg respondeu com erro (${res.status}).`, 502, "indisponivel");
}

export function dominioLimpo(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim() || /^n\/?a$/i.test(v.trim())) return null;
  const d = v
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]!;
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// ── Apollo ───────────────────────────────────────────────────────────────────

/** Senioridades da Apollo que decidem compra, da maior para a menor. */
export const SENIORIDADES_QUE_DECIDEM = ["owner", "founder", "c_suite", "partner", "vp", "director", "head", "manager"] as const;

export interface CandidatoApollo {
  id: string;
  primeiro_nome: string | null;
  cargo: string | null;
  empresa_nome: string | null;
}

/**
 * Pessoas que decidem numa empresa (por domínio OU id Apollo), num local opcional.
 * Grátis: não vem contato, só o id para o enriquecimento.
 */
export async function apolloBuscarPessoas(
  chave: string,
  alvo: { dominio?: string | null; organizacaoId?: string | null; local?: string | null; porPagina: number },
  op: Opcoes,
): Promise<RespostaDoTreg<CandidatoApollo[]>> {
  const r = await chamar(
    chave,
    "apollo.people.search",
    {
      consulta: {
        q_organization_domains_list: alvo.dominio ? [alvo.dominio] : undefined,
        organization_ids: alvo.organizacaoId ? [alvo.organizacaoId] : undefined,
        person_locations: alvo.local ? [alvo.local] : undefined,
        person_seniorities: [...SENIORIDADES_QUE_DECIDEM],
        per_page: alvo.porPagina,
        page: 1,
      },
    },
    op,
  );
  const pessoas = Array.isArray((r.saida as { people?: unknown }).people) ? (r.saida as { people: unknown[] }).people : [];
  return {
    ...r,
    saida: pessoas
      .map((p) => p as Record<string, unknown>)
      .filter((p) => typeof p.id === "string")
      .map((p) => ({
        id: p.id as string,
        primeiro_nome: texto(p.first_name),
        cargo: texto(p.title),
        empresa_nome: texto((p.organization as { name?: unknown } | undefined)?.name),
      })),
  };
}

export interface EmpresaApollo {
  id: string;
  nome: string;
  dominio: string | null;
  linkedin_url: string | null;
}

/** A empresa sem domínio, pelo nome, no Brasil. US$ 0,026 por página com resultado. */
export async function apolloBuscarEmpresa(chave: string, nome: string, op: Opcoes): Promise<RespostaDoTreg<EmpresaApollo[]>> {
  const r = await chamar(
    chave,
    "apollo.companies.search",
    { consulta: { q_organization_name: nome, organization_locations: ["Brazil"], per_page: 10, page: 1 } },
    op,
  );
  const s = r.saida as { organizations?: unknown; accounts?: unknown };
  const lista = [...(Array.isArray(s.organizations) ? s.organizations : []), ...(Array.isArray(s.accounts) ? s.accounts : [])];
  return {
    ...r,
    saida: lista
      .map((o) => o as Record<string, unknown>)
      .filter((o) => typeof o.id === "string" && texto(o.name))
      .map((o) => ({
        id: o.id as string,
        nome: texto(o.name)!,
        dominio: dominioLimpo(o.primary_domain ?? o.website_url),
        linkedin_url: texto(o.linkedin_url),
      })),
  };
}

export type VeredictoDeEmail = "valid" | "invalid" | "catch_all" | "risky" | "unknown";
const VEREDICTOS: VeredictoDeEmail[] = ["valid", "invalid", "catch_all", "risky", "unknown"];

export interface DecisorApollo {
  nome: string;
  cargo: string | null;
  linkedin_url: string | null;
  email: string | null;
  veredicto: VeredictoDeEmail | null;
  cidade: string | null;
  empresa_dominio: string | null;
}

/** `email_status` da Apollo → o nosso veredicto. */
export function veredictoDaApollo(status: unknown): VeredictoDeEmail | null {
  if (status === "verified") return "valid";
  if (status === "invalid" || status === "bounced") return "invalid";
  if (status === "unavailable" || status === null || status === undefined) return null;
  return "unknown"; // guessed, unverified, likely to engage…
}

export function normalizarPessoaDaApollo(saida: unknown): DecisorApollo | null {
  const p = (saida as { person?: unknown })?.person as Record<string, unknown> | undefined;
  if (!p) return null;
  const nome = texto(p.name) ?? ([texto(p.first_name), texto(p.last_name)].filter(Boolean).join(" ") || null);
  if (!nome) return null;
  const email = texto(p.email);
  const valido = !!email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && !/email_not_unlocked/i.test(email);
  let linkedin = texto(p.linkedin_url);
  if (linkedin && !/linkedin\.com\//i.test(linkedin)) linkedin = null;
  if (linkedin) linkedin = linkedin.replace(/^http:\/\//i, "https://");
  const org = p.organization as Record<string, unknown> | undefined;
  return {
    nome: nome.replace(/\s+/g, " "),
    cargo: texto(p.title),
    linkedin_url: linkedin,
    email: valido ? email!.toLowerCase() : null,
    veredicto: valido ? veredictoDaApollo(p.email_status) : null,
    cidade: texto(p.city),
    empresa_dominio: dominioLimpo(org?.primary_domain ?? org?.website_url),
  };
}

/** Nome completo, LinkedIn e e-mail pelo id da busca. US$ 0,026 quando acha. */
export async function apolloEnriquecer(chave: string, id: string, op: Opcoes): Promise<RespostaDoTreg<DecisorApollo | null>> {
  const r = await chamar(chave, "apollo.people.enrich", { consulta: { id } }, op);
  return { ...r, saida: normalizarPessoaDaApollo(r.saida) };
}

// ── o que a Apollo não tiver ───────────────────────────────────────────────

export interface EmailAchado {
  email: string | null;
  veredicto: VeredictoDeEmail | null;
}

/** E-mail pelo nome + domínio (ou LinkedIn), com verificação na mesma chamada. */
export async function acharEmail(
  chave: string,
  pessoa: { nome: string; dominio: string | null; linkedin_url: string | null },
  op: Opcoes,
): Promise<RespostaDoTreg<EmailAchado>> {
  const corpo = {
    full_name: pessoa.nome,
    ...(pessoa.dominio ? { domain: pessoa.dominio } : {}),
    ...(pessoa.linkedin_url ? { linkedin_url: pessoa.linkedin_url } : {}),
  };
  const r = await chamar(chave, "treg.people.email.find", { corpo }, { ...op, verificar: true });
  const o = (r.saida ?? {}) as { email?: unknown; verified?: unknown };
  const email = typeof o.email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email.trim()) ? o.email.trim().toLowerCase() : null;
  // `X-Treg-Route-Verify` põe o resultado em `_treg.verification.verdict`; sem ele,
  // vale o que o provedor disse (`verified: true` = caixa conferida).
  const dito = (r.meta?.verification as { verdict?: unknown } | undefined)?.verdict;
  const veredicto: VeredictoDeEmail | null = !email
    ? null
    : VEREDICTOS.includes(dito as VeredictoDeEmail)
      ? (dito as VeredictoDeEmail)
      : o.verified === true
        ? "valid"
        : "unknown";
  return { ...r, saida: { email, veredicto } };
}

export interface CelularAchado {
  telefone: string | null;
  tipo: string | null;
}

export async function acharCelular(
  chave: string,
  pessoa: { nome: string; dominio: string | null; linkedin_url: string | null; email: string | null },
  op: Opcoes,
): Promise<RespostaDoTreg<CelularAchado>> {
  const corpo = {
    full_name: pessoa.nome,
    ...(pessoa.dominio ? { domain: pessoa.dominio } : {}),
    ...(pessoa.linkedin_url ? { linkedin_url: pessoa.linkedin_url } : {}),
    ...(pessoa.email ? { email: pessoa.email } : {}),
  };
  const r = await chamar(chave, "treg.people.phone.find", { corpo }, op);
  const o = (r.saida ?? {}) as { phone?: unknown; line_type?: unknown };
  const telefone = typeof o.phone === "string" && o.phone.replace(/\D/g, "").length >= 10 ? o.phone.trim() : null;
  return { ...r, saida: { telefone, tipo: typeof o.line_type === "string" ? o.line_type : null } };
}
