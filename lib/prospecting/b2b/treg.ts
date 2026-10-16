/**
 * Cliente do Treg — acha o DECISOR de uma empresa já escolhida na lista B2B:
 * nome, cargo e LinkedIn (`treg.people.search`), e-mail verificado
 * (`treg.people.email.find` com verificação na mesma chamada) e, se pedido,
 * celular (`treg.people.phone.find`).
 *
 * Contrato conferido no catálogo público (treg.to/catalog/endpoints/<id>, 16/10/2026):
 *   - `POST https://treg.to/call/<capacidade>` com corpo JSON e `X-Treg-Token`;
 *   - resposta `{ output, raw, _treg: { served_by, tried } }`; o "não achou" é
 *     `output.people == []` / `output.email == null` / `output.phone == null`;
 *   - o custo da chamada vem em `X-Treg-Cost-Micro` (micro-US$, 1e-6) e o id em
 *     `X-Treg-Call-Id` — os dois vão para o livro-caixa;
 *   - `X-Treg-Route-Max-Cost: <usd>` é o teto DESTA chamada: acima dele o Treg
 *     responde 402 `route_max_cost` e não cobra nada;
 *   - `Idempotency-Key` evita pagar duas vezes numa retentativa (24 h);
 *   - `X-Treg-Meta` marca a chamada com a organização (só `[A-Za-z0-9._:-]`);
 *   - 402 sem `route_max_cost` = saldo insuficiente; nada é cobrado.
 *
 * A saída de rede passa por `allowlistedFetch` com o host da base configurada.
 */
import { z } from "zod";

import { allowlistedFetch } from "@/lib/agent-engine/edge/egress";
import { env } from "@/lib/env";

export const BASE_PADRAO_TREG = "https://treg.to";
/** A busca de pessoas tenta provedores em sequência: alguns demoram. */
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
  /** O bloco `_treg` da resposta (verificação, provedores tentados). */
  meta: Record<string, unknown> | null;
}

interface Opcoes {
  /** Teto em micro-US$ para ESTA chamada (vira `X-Treg-Route-Max-Cost`). */
  tetoMicro: number;
  organizacao: string;
  idempotencia: string;
  verificar?: boolean;
  buscar?: typeof fetch;
}

async function chamar(chave: string, capacidade: string, corpo: object, op: Opcoes): Promise<RespostaDoTreg<unknown>> {
  const base = baseDoTreg();
  const headers: Record<string, string> = {
    "X-Treg-Token": chave,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Treg-Route-Max-Cost": (Math.max(op.tetoMicro, 0) / 1_000_000).toFixed(6),
    "X-Treg-Meta": `customer=${op.organizacao.replace(/[^A-Za-z0-9._:-]/g, "")}, feature=prospeccao-b2b`,
    "Idempotency-Key": op.idempotencia,
  };
  if (op.verificar) headers["X-Treg-Route-Verify"] = "true";
  let res: Response;
  try {
    res = await allowlistedFetch(
      `${base}/call/${capacidade}`,
      { method: "POST", headers, body: JSON.stringify(corpo), signal: AbortSignal.timeout(TIMEOUT_MS) },
      { allowlist: new Set([new URL(base).host]), fetchImpl: op.buscar },
    );
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
    const erro = String((json as { error?: unknown } | null)?.error ?? (json as { detail?: { error?: unknown } } | null)?.detail?.error ?? "");
    if (erro.includes("route_max_cost"))
      throw new ErroDoTreg("Esta consulta custaria mais que o teto por empresa.", 402, "teto");
    throw new ErroDoTreg("Sem saldo no Treg. Recarregue o saldo e continue.", 402, "saldo");
  }
  // 409: a mesma chave de idempotência ainda está rodando no Treg (o nosso relógio
  // estourou antes do dele) — a retentativa recebe a resposta, sem pagar de novo.
  if (res.status === 429 || res.status === 503 || res.status === 409 || res.status === 410 || res.status === 202)
    throw new ErroDoTreg("O Treg está ocupado agora. Tente de novo em instantes.", 429, "limite");
  // 422: a consulta foi recusada antes de sair (filtro estrito); nada é cobrado e
  // repetir a mesma consulta não muda o resultado.
  if (res.status === 422) throw new ErroDoTreg("O Treg recusou a consulta desta empresa.", 422, "recusada");
  if (!res.ok) throw new ErroDoTreg(`O Treg respondeu com erro (${res.status}).`, 502, "indisponivel");
  const saida = (json as { output?: unknown } | null)?.output;
  if (saida === undefined) throw new ErroDoTreg("O Treg devolveu uma resposta ilegível.", 502, "resposta");
  const meta = ((json as { _treg?: unknown } | null)?._treg ?? null) as Record<string, unknown> | null;
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

// ── normalização ─────────────────────────────────────────────────────────────
// `people.search` devolve as linhas do PROVEDOR que atendeu, e o formato muda de
// um para outro. Lemos os nomes de campo mais comuns; linha sem nome é descartada.

export interface PessoaAchada {
  nome: string;
  primeiro_nome: string | null;
  sobrenome: string | null;
  cargo: string | null;
  linkedin_url: string | null;
  local: string | null;
  /** A empresa que a LINHA diz (o provedor pode devolver gente de outra empresa). */
  empresa_dominio: string | null;
  empresa_nome: string | null;
}

function texto(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object" && "name" in v) return texto((v as { name: unknown }).name);
  return null;
}

function primeiro(o: Record<string, unknown>, chaves: string[]): string | null {
  for (const k of chaves) {
    const v = k.includes(".")
      ? k.split(".").reduce<unknown>((acc, p) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[p] : undefined), o)
      : o[k];
    const t = texto(v);
    if (t) return t;
  }
  return null;
}

export function dominioLimpo(v: string | null): string | null {
  if (!v || /^n\/?a$/i.test(v)) return null;
  const d = v
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]!;
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

export function normalizarPessoa(bruto: unknown): PessoaAchada | null {
  if (!bruto || typeof bruto !== "object") return null;
  const o = bruto as Record<string, unknown>;
  const primeiroNome = primeiro(o, ["first_name", "firstName", "given_name", "name.first"]);
  const sobrenome = primeiro(o, ["last_name", "lastName", "family_name", "name.last"]);
  const nome =
    primeiro(o, ["full_name", "fullName", "name", "person_name", "display_name"]) ??
    ([primeiroNome, sobrenome].filter(Boolean).join(" ") || null);
  if (!nome || nome.length < 3) return null;
  let linkedin = primeiro(o, [
    "linkedin_url",
    "linkedinUrl",
    "linkedin",
    "employee_linkedin",
    "profile_url",
    "profileUrl",
    "linkedin_profile",
    "url",
  ]);
  if (linkedin && !/linkedin\.com\//i.test(linkedin)) linkedin = null;
  if (linkedin && !/^https?:\/\//i.test(linkedin)) linkedin = `https://${linkedin.replace(/^\/+/, "")}`;
  return {
    nome: nome.replace(/\s+/g, " "),
    primeiro_nome: primeiroNome,
    sobrenome,
    cargo: primeiro(o, ["title", "job_title", "jobTitle", "position", "headline", "role", "current_title"]),
    linkedin_url: linkedin,
    local: primeiro(o, ["location", "location_name", "locality", "city", "location.city", "country"]),
    empresa_dominio: dominioLimpo(
      primeiro(o, ["company_domain", "company.domain", "company_url", "email_domain", "organization.primary_domain", "company.website", "organization.website_url"]),
    ),
    empresa_nome: primeiro(o, ["company_name", "company.name", "organization.name", "organization_name", "current_company", "employer"]),
  };
}

const saidaBusca = z.object({ people: z.array(z.unknown()).default([]) }).passthrough();

/**
 * As pessoas de UMA empresa. Medido no Treg real (16/10/2026): o filtro de cargo é
 * ignorado pelos provedores (vem operador, analista…), e a busca sem domínio traz
 * gente de OUTRAS empresas da cidade. Por isso pede-se a lista da empresa sem cargo
 * e quem filtra — empresa certa e cargo de decisão — é `./decisores.ts`.
 */
export async function buscarPessoas(
  chave: string,
  alvo: { dominio: string | null; empresa: string; cidade: string | null; limite: number },
  op: Opcoes,
): Promise<RespostaDoTreg<PessoaAchada[]>> {
  const corpo = alvo.dominio
    ? { company_domain: alvo.dominio, country: "BR", limit: alvo.limite }
    : {
        q: alvo.empresa,
        country: "BR",
        ...(alvo.cidade ? { location: `${alvo.cidade}, Brazil` } : {}),
        limit: alvo.limite,
      };
  const r = await chamar(chave, "treg.people.search", corpo, op);
  const lido = saidaBusca.safeParse(r.saida ?? {});
  const pessoas = (lido.success ? lido.data.people : [])
    .map(normalizarPessoa)
    .filter((p): p is PessoaAchada => !!p);
  const vistos = new Set<string>();
  return {
    ...r,
    saida: pessoas.filter((p) => {
      const k = p.nome.toLowerCase();
      if (vistos.has(k)) return false;
      vistos.add(k);
      return true;
    }),
  };
}

export type VeredictoDeEmail = "valid" | "invalid" | "catch_all" | "risky" | "unknown";
const VEREDICTOS: VeredictoDeEmail[] = ["valid", "invalid", "catch_all", "risky", "unknown"];

export interface EmailAchado {
  email: string | null;
  veredicto: VeredictoDeEmail | null;
}

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
  const r = await chamar(chave, "treg.people.email.find", corpo, { ...op, verificar: true });
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
  const r = await chamar(chave, "treg.people.phone.find", corpo, op);
  const o = (r.saida ?? {}) as { phone?: unknown; line_type?: unknown };
  const telefone = typeof o.phone === "string" && o.phone.replace(/\D/g, "").length >= 10 ? o.phone.trim() : null;
  return { ...r, saida: { telefone, tipo: typeof o.line_type === "string" ? o.line_type : null } };
}
