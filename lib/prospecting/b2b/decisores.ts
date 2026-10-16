/**
 * Decisores das empresas escolhidas, pelo Treg (migration 9003).
 *
 * Uma RODADA cobre as empresas MARCADAS de uma busca. Cada empresa é uma linha do
 * livro-caixa (`prospecting_b2b_enrichment_items`), tomada por lease
 * (`for update skip locked`): a tela avança a rodada enquanto está aberta
 * (`enrich_step`) e o cron da prospecção continua se ela fechar — os dois nunca
 * processam a mesma empresa.
 *
 * Por empresa: para cada cargo-alvo, `people.search` (domínio + cargo; sem
 * domínio, nome da empresa + cargo + cidade) até achar quantas pessoas a rodada
 * pede; para cada pessoa, o e-mail com verificação na mesma chamada e, se pedido,
 * o celular.
 *
 * Dinheiro:
 *   - o teto da RODADA é duro: antes de cada chamada, o teto da chamada
 *     (`X-Treg-Route-Max-Cost`) é o que falta da rodada, limitado pelo teto da
 *     capacidade — o Treg recusa (sem cobrar) o que passaria disso;
 *   - cada chamada leva uma chave de idempotência estável (item + passo): a
 *     retentativa de uma empresa nunca paga de novo o que já pagou;
 *   - todo custo vai para o livro (`prospecting_provider_costs`, com o call id do
 *     Treg) e soma no gasto da rodada e da empresa.
 *
 * Supressão: quem foi removido com "não buscar de novo" tem o hash (sha256) do
 * e-mail, do LinkedIn e de nome+CNPJ guardado; a rodada seguinte não o grava.
 */
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import { logger } from "@/lib/logger";
import { lerCredencial } from "./credenciais";
import { registrarCusto } from "./custos";
import type { EmpresaB2b } from "./schema";
import { acharCelular, acharEmail, buscarPessoas, ErroDoTreg, type PessoaAchada, type RespostaDoTreg } from "./treg";

export class ErroDosDecisores extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = "ErroDosDecisores";
  }
}

/**
 * Teto por chamada (micro-US$). A busca de pessoas cobra também os "não achou" de
 * vários provedores da cascata (medido: US$ 0,05 por empresa sem ninguém, com o
 * teto antigo de US$ 0,30) — o teto baixo corta a cascata cedo. O e-mail custa
 * ~US$ 0,005; o celular é o caro e só sai quando pedido.
 */
const TETO_DA_CAPACIDADE = { busca: 50_000, email: 30_000, celular: 300_000 } as const;
/** Linhas pedidas por empresa: o filtro de cargo é nosso, então pede-se a equipe. */
const PESSOAS_POR_BUSCA = 20;
const TENTATIVAS = 3;
const LEASE = "3 minutes";

export type StatusDaRodada = "running" | "done" | "stopped_budget" | "no_balance" | "failed" | "cancelled";

export interface Rodada {
  id: string;
  search_id: string;
  cargos: string[];
  por_empresa: number;
  com_celular: boolean;
  teto_micro: number;
  gasto_micro: number;
  status: StatusDaRodada;
  empresas_total: number;
  empresas_feitas: number;
  contatos_achados: number;
  error: string | null;
  created_at: Date;
}

const COLUNAS_DA_RODADA =
  "id,search_id,cargos,por_empresa,com_celular,teto_micro::float8 as teto_micro,gasto_micro::float8 as gasto_micro,status,empresas_total,empresas_feitas,contatos_achados,error,created_at";

export function hashDeSupressao(tipo: "email" | "linkedin" | "pessoa", valor: string): string {
  const normal = valor
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\/+$/, "");
  return createHash("sha256").update(`${tipo}:${normal}`).digest("hex");
}

/** Os hashes que identificam uma pessoa achada (o que a supressão compara). */
export function hashesDaPessoa(p: { nome: string; email?: string | null; linkedin_url?: string | null }, cnpj: string): string[] {
  const hashes = [hashDeSupressao("pessoa", `${cnpj}:${p.nome}`)];
  if (p.email) hashes.push(hashDeSupressao("email", p.email));
  if (p.linkedin_url) hashes.push(hashDeSupressao("linkedin", p.linkedin_url.replace(/^https?:\/\/(www\.)?/i, "")));
  return hashes;
}

// ── quem é decisor, e de qual empresa ────────────────────────────────────────

function normal(t: string): string {
  return t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const PALAVRAS_VAZIAS = new Set([
  "ltda", "sa", "s", "a", "me", "epp", "eireli", "do", "da", "de", "dos", "das", "e", "em", "industria", "industrial",
  "comercio", "comercial", "servicos", "brasil", "brazil", "the", "and", "grupo", "cia", "companhia", "metalurgica",
  "metais", "produtos", "fabrica", "recuperacao", "judicial", "importacao", "exportacao",
]);

/** As palavras que identificam a empresa pelo nome (sem "LTDA", "Indústria", "de"…). */
export function palavrasDaEmpresa(empresa: Pick<EmpresaB2b, "razao_social" | "nome_fantasia">): string[] {
  const deUmNome = (n: string | null) => normal(n ?? "").split(" ").filter((w) => w.length >= 3 && !PALAVRAS_VAZIAS.has(w));
  return [...new Set([...deUmNome(empresa.nome_fantasia), ...deUmNome(empresa.razao_social)])];
}

/**
 * A linha é desta empresa? Com domínio dos dois lados, o domínio decide. Sem, o
 * nome da empresa da linha tem de conter a primeira palavra própria do nome dela
 * (a busca por nome traz gente de OUTRAS empresas da cidade — medido).
 * Linha sem empresa nenhuma só passa quando a busca foi pelo domínio.
 */
export function ehDaEmpresa(
  p: Pick<PessoaAchada, "empresa_dominio" | "empresa_nome">,
  empresa: Pick<EmpresaB2b, "razao_social" | "nome_fantasia" | "dominio">,
): boolean {
  const dominio = empresa.dominio?.toLowerCase().replace(/^www\./, "") ?? null;
  if (dominio && p.empresa_dominio) return p.empresa_dominio === dominio || p.empresa_dominio.endsWith(`.${dominio}`);
  if (p.empresa_nome) {
    const daLinha = ` ${normal(p.empresa_nome)} `;
    const nossas = palavrasDaEmpresa(empresa);
    return nossas.length > 0 && daLinha.includes(` ${nossas[0]} `);
  }
  return !!dominio;
}

const NAO_DECIDE = /\b(assistente|auxiliar|analista|estagiari|operador|tecnic|coordenador|supervisor|lider|trainee|junior|aprendiz|vendedor|representante|recepcionista|motorista|soldador|torneiro|mecanico|eletricista|inspetor|almoxarife|comprador|projetista|desenhista|instrutor|professor|estudante)/;
const DECIDE_TOPO = /\b(ceo|presidente|president|socio|socia|proprietari|owner|fundador|fundadora|founder|cofounder|co founder|managing director|diretor geral|diretora geral|diretor presidente|general manager|gerente geral|administrador|administradora)\b/;
const DECIDE = /\b(diretor|diretora|director|cfo|coo|cto|cio|chief|vp|vice presidente|head|superintendente|gerente|manager|plant manager)\b/;

/**
 * Quanto a pessoa decide, pelo cargo: 0 = não decide (fica fora), 1 = gerente /
 * diretor de área, 2 = topo (CEO, sócio, dono, diretor geral). Um cargo
 * "operacional" vence a palavra "gerente" só quando não há palavra de topo.
 */
export function nivelDeDecisao(cargo: string | null): 0 | 1 | 2 {
  if (!cargo) return 0;
  const c = normal(cargo);
  if (DECIDE_TOPO.test(c)) return 2;
  if (NAO_DECIDE.test(c)) return 0;
  if (/\bdiretor(a)? de arte\b|\bart director\b/.test(c)) return 0;
  return DECIDE.test(c) ? 1 : 0;
}

/** A pessoa casa com um dos cargos que a pessoa escolheu? (todas as palavras dele) */
export function casaComCargo(cargo: string | null, alvo: string): boolean {
  if (!cargo) return false;
  const c = ` ${normal(cargo)} `;
  const palavras = normal(alvo).split(" ").filter((w) => w.length >= 2 && !["de", "da", "do", "e"].includes(w));
  return palavras.length > 0 && palavras.every((w) => c.includes(` ${w}`));
}

/**
 * Das pessoas da busca, os decisores DESTA empresa, na ordem: primeiro quem casa
 * com os cargos escolhidos (na ordem deles), depois o topo, depois diretores e
 * gerentes. Quem não decide, ou é de outra empresa, nunca entra.
 */
export function escolherDecisores(
  pessoas: PessoaAchada[],
  empresa: Pick<EmpresaB2b, "razao_social" | "nome_fantasia" | "dominio">,
  cargos: string[],
  quantos: number,
): PessoaAchada[] {
  const vistos = new Set<string>();
  return pessoas
    .filter((p) => ehDaEmpresa(p, empresa) && nivelDeDecisao(p.cargo) > 0)
    .map((p) => {
      const i = cargos.findIndex((alvo) => casaComCargo(p.cargo, alvo));
      return { p, ordem: i >= 0 ? i : cargos.length + (2 - nivelDeDecisao(p.cargo)) };
    })
    .sort((a, b) => a.ordem - b.ordem)
    .map((x) => x.p)
    .filter((p) => {
      const k = normal(p.nome);
      if (vistos.has(k)) return false;
      vistos.add(k);
      return true;
    })
    .slice(0, quantos);
}

export async function iniciarRodada(
  db: pg.Pool,
  admin: SupabaseClient,
  org: string,
  userId: string | null,
  e: { request_id: string; search_id: string; cargos: string[]; por_empresa: number; com_celular: boolean; teto_usd: number },
): Promise<{ rodada: Rodada; repetida: boolean }> {
  // Sem token não cria rodada nenhuma: ela falharia sem nada a mostrar.
  await lerCredencial(db, admin, org, "treg");
  const busca = await db.query("select id from prospecting_b2b_searches where organization_id=$1 and id=$2", [org, e.search_id]);
  if (!busca.rows[0]) throw new ErroDosDecisores("Busca não encontrada.", 404);
  const ativa = await db.query(
    "select 1 from prospecting_b2b_enrichment_runs where organization_id=$1 and search_id=$2 and status='running' and request_id<>$3",
    [org, e.search_id, e.request_id],
  );
  if (ativa.rows[0]) throw new ErroDosDecisores("Já há uma busca de decisores em andamento nesta lista.", 409);

  const cliente = await db.connect();
  try {
    await cliente.query("begin");
    const criada = await cliente.query<Rodada>(
      `insert into prospecting_b2b_enrichment_runs
         (organization_id,search_id,request_id,cargos,por_empresa,com_celular,teto_micro,created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (organization_id,request_id) do nothing
       returning ${COLUNAS_DA_RODADA}`,
      [org, e.search_id, e.request_id, e.cargos, e.por_empresa, e.com_celular, Math.round(e.teto_usd * 1_000_000), userId],
    );
    if (!criada.rows[0]) {
      await cliente.query("rollback");
      const { rows } = await db.query<Rodada>(
        `select ${COLUNAS_DA_RODADA} from prospecting_b2b_enrichment_runs where organization_id=$1 and request_id=$2`,
        [org, e.request_id],
      );
      return { rodada: rows[0]!, repetida: true };
    }
    const rodada = criada.rows[0];
    // Empresas marcadas que ainda não têm decisor: as que já têm ficam de fora
    // (não se paga de novo por quem já foi achado).
    const itens = await cliente.query(
      `insert into prospecting_b2b_enrichment_items (organization_id,run_id,company_id)
       select $1,$2,c.id from prospecting_b2b_companies c
        where c.organization_id=$1 and c.search_id=$3 and c.selected
          and not exists (select 1 from prospecting_b2b_contacts k where k.organization_id=$1 and k.company_id=c.id)
       on conflict (run_id,company_id) do nothing`,
      [org, rodada.id, e.search_id],
    );
    const total = itens.rowCount ?? 0;
    const { rows } = await cliente.query<Rodada>(
      `update prospecting_b2b_enrichment_runs set empresas_total=$3,status=case when $3=0 then 'done' else status end,updated_at=now()
        where organization_id=$1 and id=$2 returning ${COLUNAS_DA_RODADA}`,
      [org, rodada.id, total],
    );
    await cliente.query("commit");
    return { rodada: rows[0]!, repetida: false };
  } catch (erro) {
    await cliente.query("rollback").catch(() => {});
    throw erro;
  } finally {
    cliente.release();
  }
}

interface ItemTomado {
  id: string;
  company_id: string;
  tentativas: number;
  cnpj: string;
  data: EmpresaB2b;
}

async function tomarItem(db: pg.Pool, org: string, runId: string): Promise<ItemTomado | null> {
  const { rows } = await db.query<ItemTomado>(
    `with alvo as (
       select i.id from prospecting_b2b_enrichment_items i
        where i.organization_id=$1 and i.run_id=$2 and i.status='pending'
          and (i.lease_until is null or i.lease_until < now()) and i.tentativas < ${TENTATIVAS}
        order by i.created_at
        limit 1
        for update skip locked
     )
     update prospecting_b2b_enrichment_items i
        set lease_until=now()+interval '${LEASE}', tentativas=i.tentativas+1, updated_at=now()
       from alvo, prospecting_b2b_companies c
      where i.id=alvo.id and c.id=i.company_id and c.organization_id=$1
      returning i.id,i.company_id,i.tentativas,c.cnpj,c.data`,
    [org, runId],
  );
  return rows[0] ?? null;
}

async function lerRodada(db: pg.Pool | pg.PoolClient, org: string, runId: string): Promise<Rodada | null> {
  const { rows } = await db.query<Rodada>(
    `select ${COLUNAS_DA_RODADA} from prospecting_b2b_enrichment_runs where organization_id=$1 and id=$2`,
    [org, runId],
  );
  return rows[0] ?? null;
}

async function encerrar(db: pg.Pool, org: string, runId: string, status: StatusDaRodada, erro: string | null) {
  await db.query(
    "update prospecting_b2b_enrichment_runs set status=$3,error=$4,updated_at=now() where organization_id=$1 and id=$2 and status='running'",
    [org, runId, status, erro],
  );
}

/**
 * Processa a rodada até o prazo (ms) acabar, a fila esvaziar, o teto bater ou o
 * saldo acabar. Devolve a rodada atualizada. Nunca processa rodada de outra org.
 */
export async function processarRodada(
  db: pg.Pool,
  admin: SupabaseClient,
  org: string,
  runId: string,
  prazoMs: number,
  buscar?: typeof fetch,
): Promise<Rodada> {
  const fim = Date.now() + prazoMs;
  let rodada = await lerRodada(db, org, runId);
  if (!rodada) throw new ErroDosDecisores("Busca de decisores não encontrada.", 404);
  if (rodada.status !== "running") return rodada;
  let chave: string;
  try {
    chave = await lerCredencial(db, admin, org, "treg");
  } catch (e) {
    await encerrar(db, org, runId, "failed", e instanceof Error ? e.message : String(e));
    return (await lerRodada(db, org, runId))!;
  }

  while (Date.now() < fim) {
    rodada = (await lerRodada(db, org, runId))!;
    if (rodada.status !== "running") break;
    if (rodada.gasto_micro >= rodada.teto_micro) {
      await encerrar(db, org, runId, "stopped_budget", null);
      break;
    }
    const item = await tomarItem(db, org, runId);
    if (!item) {
      const pendentes = await db.query(
        `select count(*)::int as n from prospecting_b2b_enrichment_items
          where organization_id=$1 and run_id=$2 and status='pending' and tentativas < ${TENTATIVAS}`,
        [org, runId],
      );
      if ((pendentes.rows[0]?.n ?? 0) === 0) {
        // Quem esgotou as tentativas fecha como falha; a rodada termina.
        await db.query(
          "update prospecting_b2b_enrichment_items set status='failed',updated_at=now() where organization_id=$1 and run_id=$2 and status='pending'",
          [org, runId],
        );
        await encerrar(db, org, runId, "done", null);
      }
      break;
    }
    const parada = await processarEmpresa(db, org, rodada, item, chave, buscar);
    if (parada) {
      await encerrar(db, org, runId, parada.status, parada.erro);
      break;
    }
  }
  return (await lerRodada(db, org, runId))!;
}

/** Uma empresa. Devolve a parada da RODADA (saldo, token), ou `null` para seguir. */
async function processarEmpresa(
  db: pg.Pool,
  org: string,
  rodada: Rodada,
  item: ItemTomado,
  chave: string,
  buscar?: typeof fetch,
): Promise<{ status: StatusDaRodada; erro: string | null } | null> {
  const empresa = item.data;
  const nomeDaEmpresa = empresa.nome_fantasia || empresa.razao_social;
  let gastoDaEmpresa = 0;
  const suprimidos = new Set(
    (
      await db.query<{ chave_hash: string }>(
        "select chave_hash from prospecting_b2b_suppressions where organization_id=$1",
        [org],
      )
    ).rows.map((r) => r.chave_hash),
  );

  /** Uma chamada ao Treg com o teto que falta da rodada; lança o custo no livro. */
  const chamar = async <T>(
    passo: string,
    capacidade: keyof typeof TETO_DA_CAPACIDADE,
    fn: (op: { tetoMicro: number; organizacao: string; idempotencia: string; buscar?: typeof fetch }) => Promise<RespostaDoTreg<T>>,
  ): Promise<T | null> => {
    const atual = (await lerRodada(db, org, rodada.id))!;
    const falta = atual.teto_micro - atual.gasto_micro;
    if (falta <= 0) throw new ErroDoTreg("teto da rodada", 402, "teto");
    try {
      const r = await fn({
        tetoMicro: Math.min(falta, TETO_DA_CAPACIDADE[capacidade]),
        organizacao: org,
        idempotencia: `b2b-${item.id}-${passo}`,
        buscar,
      });
      if (r.custoMicro > 0) {
        gastoDaEmpresa += r.custoMicro;
        await db.query(
          "update prospecting_b2b_enrichment_runs set gasto_micro=gasto_micro+$3,updated_at=now() where organization_id=$1 and id=$2",
          [org, rodada.id, r.custoMicro],
        );
        await registrarCusto(db, org, {
          provider: "treg",
          operacao: capacidade,
          unidades: 1,
          custoUsdMicro: r.custoMicro,
          referenciaId: rodada.id,
          callId: r.callId,
        });
      }
      return r.saida;
    } catch (e) {
      // Uma consulta mais cara que o que sobra é "não achou" desta empresa, não
      // falha da rodada: a próxima pode caber.
      if (e instanceof ErroDoTreg && (e.motivo === "teto" || e.motivo === "recusada")) return null;
      throw e;
    }
  };

  try {
    // Uma busca por empresa (o cargo é filtrado aqui, não no provedor).
    const achadas = await chamar("busca", "busca", (op) =>
      buscarPessoas(chave, { dominio: empresa.dominio, empresa: nomeDaEmpresa, cidade: empresa.cidade, limite: PESSOAS_POR_BUSCA }, op),
    );
    const pessoas = escolherDecisores(
      (achadas ?? []).filter((p) => !hashesDaPessoa(p, item.cnpj).some((h) => suprimidos.has(h))),
      empresa,
      rodada.cargos,
      rodada.por_empresa,
    );

    let contatos = 0;
    for (const [i, p] of pessoas.entries()) {
      const email = await chamar(`email-${i}`, "email", (op) =>
        acharEmail(chave, { nome: p.nome, dominio: empresa.dominio, linkedin_url: p.linkedin_url }, op),
      );
      if (email?.email && suprimidos.has(hashDeSupressao("email", email.email))) continue;
      const celular = rodada.com_celular
        ? await chamar(`celular-${i}`, "celular", (op) =>
            acharCelular(
              chave,
              { nome: p.nome, dominio: empresa.dominio, linkedin_url: p.linkedin_url, email: email?.email ?? null },
              op,
            ),
          )
        : null;
      const { rowCount } = await db.query(
        `insert into prospecting_b2b_contacts
           (organization_id,company_id,run_id,nome,cargo,linkedin_url,email,email_status,telefone,telefone_tipo,fonte)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'treg')
         on conflict (company_id,lower(nome)) do nothing`,
        [
          org,
          item.company_id,
          rodada.id,
          p.nome,
          p.cargo,
          p.linkedin_url,
          email?.email ?? null,
          email?.veredicto ?? null,
          celular?.telefone ?? null,
          celular?.tipo ?? null,
        ],
      );
      contatos += rowCount ?? 0;
    }

    await db.query(
      `update prospecting_b2b_enrichment_items set status=$3,custo_micro=custo_micro+$4,contatos=$5,lease_until=null,error=null,updated_at=now()
        where organization_id=$1 and id=$2`,
      [org, item.id, contatos > 0 ? "done" : "miss", gastoDaEmpresa, contatos],
    );
    await db.query(
      `update prospecting_b2b_enrichment_runs set empresas_feitas=empresas_feitas+1,contatos_achados=contatos_achados+$3,updated_at=now()
        where organization_id=$1 and id=$2`,
      [org, rodada.id, contatos],
    );
    return null;
  } catch (e) {
    const motivo = e instanceof ErroDoTreg ? e.motivo : null;
    const mensagem = e instanceof Error ? e.message : String(e);
    // A empresa volta para a fila (o que já foi pago fica no livro; a retentativa
    // usa as mesmas chaves de idempotência e não paga de novo).
    await db.query(
      `update prospecting_b2b_enrichment_items set custo_micro=custo_micro+$3,lease_until=null,error=$4,updated_at=now(),
              status=case when tentativas >= ${TENTATIVAS} then 'failed' else 'pending' end
        where organization_id=$1 and id=$2`,
      [org, item.id, gastoDaEmpresa, mensagem.slice(0, 300)],
    );
    if (motivo === "saldo") return { status: "no_balance", erro: mensagem };
    if (motivo === "chave") return { status: "failed", erro: mensagem };
    if (motivo === "teto") return { status: "stopped_budget", erro: null };
    if (!(e instanceof ErroDoTreg))
      logger.error("[prospeccao-b2b] decisores: erro inesperado numa empresa", {
        organization_id: org,
        run_id: rodada.id,
        error: mensagem,
      });
    return null;
  }
}

export async function cancelarRodada(db: pg.Pool, org: string, runId: string): Promise<Rodada> {
  await encerrar(db, org, runId, "cancelled", null);
  const rodada = await lerRodada(db, org, runId);
  if (!rodada) throw new ErroDosDecisores("Busca de decisores não encontrada.", 404);
  return rodada;
}

export async function listarRodadas(db: pg.Pool | pg.PoolClient, org: string, searchId: string): Promise<Rodada[]> {
  const { rows } = await db.query<Rodada>(
    `select ${COLUNAS_DA_RODADA} from prospecting_b2b_enrichment_runs where organization_id=$1 and search_id=$2 order by created_at desc limit 10`,
    [org, searchId],
  );
  return rows;
}

export interface ContatoB2b {
  id: string;
  company_id: string;
  nome: string;
  cargo: string | null;
  linkedin_url: string | null;
  email: string | null;
  email_status: string | null;
  telefone: string | null;
  telefone_tipo: string | null;
  custo_micro: number;
  expires_at: Date;
}

export async function listarContatos(db: pg.Pool | pg.PoolClient, org: string, searchId: string): Promise<ContatoB2b[]> {
  const { rows } = await db.query<ContatoB2b>(
    `select k.id,k.company_id,k.nome,k.cargo,k.linkedin_url,k.email,k.email_status,k.telefone,k.telefone_tipo,
            k.custo_micro::float8 as custo_micro,k.expires_at
       from prospecting_b2b_contacts k
       join prospecting_b2b_companies c on c.id=k.company_id and c.organization_id=k.organization_id
      where k.organization_id=$1 and c.search_id=$2 and k.expires_at > now()
      order by k.created_at`,
    [org, searchId],
  );
  return rows;
}

/** Remove o decisor e guarda os hashes dele: nenhuma rodada o grava de novo. */
export async function removerContato(db: pg.Pool, org: string, contactId: string): Promise<void> {
  const { rows } = await db.query<{ nome: string; email: string | null; linkedin_url: string | null; cnpj: string }>(
    `select k.nome,k.email,k.linkedin_url,c.cnpj from prospecting_b2b_contacts k
       join prospecting_b2b_companies c on c.id=k.company_id
      where k.organization_id=$1 and k.id=$2`,
    [org, contactId],
  );
  const contato = rows[0];
  if (!contato) throw new ErroDosDecisores("Contato não encontrado.", 404);
  const cliente = await db.connect();
  try {
    await cliente.query("begin");
    await cliente.query(
      `insert into prospecting_b2b_suppressions (organization_id,chave_hash)
       select $1, unnest($2::text[]) on conflict do nothing`,
      [org, hashesDaPessoa(contato, contato.cnpj)],
    );
    await cliente.query("delete from prospecting_b2b_contacts where organization_id=$1 and id=$2", [org, contactId]);
    await cliente.query("commit");
  } catch (e) {
    await cliente.query("rollback").catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

/**
 * O cron da prospecção continua as rodadas abertas que a tela deixou (fechou a
 * aba, caiu a conexão). A organização vem da própria linha da rodada. Devolve,
 * por rodada tocada, o que mudou — o cron audita só onde houve efeito.
 */
export async function avancarRodadasAbertas(
  db: pg.Pool,
  admin: SupabaseClient,
  prazoMs: number,
): Promise<Array<{ organizacao: string; rodada: string; empresas: number; status: StatusDaRodada; gasto_micro: number }>> {
  const { rows } = await db.query<{ id: string; organization_id: string; feitas: number; gasto: number }>(
    `select id,organization_id,empresas_feitas as feitas,gasto_micro::float8 as gasto from prospecting_b2b_enrichment_runs
      where status='running' and updated_at < now() - interval '30 seconds'
      order by updated_at limit 5`,
  );
  const fim = Date.now() + prazoMs;
  const tocadas: Array<{ organizacao: string; rodada: string; empresas: number; status: StatusDaRodada; gasto_micro: number }> = [];
  for (const r of rows) {
    const resta = fim - Date.now();
    if (resta <= 1000) break;
    const depois = await processarRodada(db, admin, r.organization_id, r.id, resta);
    tocadas.push({
      organizacao: r.organization_id,
      rodada: r.id,
      empresas: depois.empresas_feitas - r.feitas,
      status: depois.status,
      gasto_micro: depois.gasto_micro - r.gasto,
    });
  }
  return tocadas;
}
