/**
 * A busca B2B por CNPJ, do filtro à lista: cria a busca (idempotente pelo
 * `request_id`), lê as páginas da CNPJá até o teto pedido, grava as empresas e
 * devolve o que a tela mostra. "Carregar mais" continua pelo token salvo.
 *
 * Toda leitura e escrita filtra `organization_id` (a org vem da sessão/token,
 * nunca do corpo): as tabelas só a service role alcança.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import { cnaePorCodigo, municipioPorCodigo } from "./catalogos";
import { buscarPagina, creditosEstimados, ErroDaCnpja, POR_PAGINA } from "./cnpja";
import { lerCredencial, precoDaUnidade } from "./credenciais";
import { centavosDosCreditos, registrarCusto } from "./custos";
import { listarContatos } from "./decisores";
import type { EmpresaB2b, FiltrosB2b } from "./schema";

export class ErroDaBuscaB2b extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = "ErroDaBuscaB2b";
  }
}

/** Páginas por requisição: a busca roda dentro do pedido HTTP, então tem teto. */
const PAGINAS_POR_PEDIDO = 10;

/**
 * Confere os filtros contra o catálogo oficial: código de CNAE ou de município que
 * não existe é recusado, e cidade fora dos estados escolhidos também.
 */
export function conferirFiltros(f: FiltrosB2b): void {
  const cnaeInvalido = f.cnaes.find((c) => !cnaePorCodigo(c));
  if (cnaeInvalido) throw new ErroDaBuscaB2b(`CNAE ${cnaeInvalido} não existe no catálogo oficial.`);
  for (const codigo of f.municipios) {
    const m = municipioPorCodigo(codigo);
    if (!m) throw new ErroDaBuscaB2b(`Município ${codigo} não existe no catálogo do IBGE.`);
    if (f.ufs.length && !f.ufs.includes(m.u))
      throw new ErroDaBuscaB2b(`${m.n}/${m.u} está fora dos estados escolhidos.`);
  }
}

interface LinhaDaBusca {
  id: string;
  name: string;
  filtros: FiltrosB2b;
  status: "running" | "done" | "partial" | "failed";
  next_token: string | null;
  credits_used: number;
  results_count: number;
  total_available: number | null;
  error: string | null;
  created_at: Date;
}

async function gravarEmpresas(
  db: pg.Pool | pg.PoolClient,
  org: string,
  searchId: string,
  empresas: EmpresaB2b[],
): Promise<number> {
  if (!empresas.length) return 0;
  const { rowCount } = await db.query(
    `insert into prospecting_b2b_companies
       (organization_id,search_id,cnpj,razao_social,uf,municipio_ibge,porte_id,capital_social,data)
     select $1,$2,e->>'cnpj',e->>'razao_social',e->>'uf',(e->>'municipio_ibge')::int,
            (e->>'porte_id')::smallint,(e->>'capital_social')::numeric,e
       from jsonb_array_elements($3::jsonb) e
     on conflict (search_id,cnpj) do nothing`,
    [org, searchId, JSON.stringify(empresas)],
  );
  return rowCount ?? 0;
}

/**
 * Lê páginas até o teto da busca (ou o fim). Começa pelos filtros quando não há
 * token; continua pelo token quando há. Atualiza créditos e status a cada página,
 * para que um erro no meio não apague o que já foi pago.
 */
async function lerPaginas(
  db: pg.Pool,
  admin: SupabaseClient,
  org: string,
  busca: LinhaDaBusca,
): Promise<LinhaDaBusca> {
  const chave = await lerCredencial(db, admin, org, "cnpja");
  const preco = await precoDaUnidade(db, org, "cnpja");
  let token = busca.next_token;
  let gravadas = busca.results_count;
  let creditos = busca.credits_used;
  let total = busca.total_available;
  let status: LinhaDaBusca["status"] = "done";
  let erro: string | null = null;
  const teto = busca.filtros.max_resultados;
  try {
    for (let i = 0; i < PAGINAS_POR_PEDIDO && gravadas < teto; i += 1) {
      const falta = teto - gravadas;
      const pagina = await buscarPagina(
        chave,
        token ? { token } : { filtros: busca.filtros, limite: Math.min(POR_PAGINA, falta) },
      );
      const daPagina = Math.ceil(pagina.recebidos / 10);
      creditos += daPagina;
      if (daPagina > 0)
        await registrarCusto(db, org, {
          provider: "cnpja",
          operacao: busca.next_token ? "carregar_mais" : "busca",
          unidades: daPagina,
          custoBrlCents: centavosDosCreditos(daPagina, preco),
          referenciaId: busca.id,
        });
      total = pagina.total ?? total;
      gravadas += await gravarEmpresas(db, org, busca.id, pagina.empresas.slice(0, falta));
      token = pagina.proximo;
      if (!token || pagina.recebidos === 0) break;
    }
    // Parar no teto com página seguinte disponível é "pronto até aqui", não
    // parcial: o token fica guardado e o "Carregar mais" continua dele.
  } catch (e) {
    status = gravadas > 0 ? "partial" : "failed";
    erro = e instanceof ErroDaCnpja || e instanceof Error ? e.message : String(e);
    if (e instanceof ErroDaCnpja && e.motivo === "chave") status = "failed";
  }
  const { rows } = await db.query<LinhaDaBusca>(
    `update prospecting_b2b_searches set next_token=$3,credits_used=$4,results_count=$5,total_available=$6,
       status=$7,error=$8,updated_at=now()
     where organization_id=$1 and id=$2
     returning id,name,filtros,status,next_token,credits_used,results_count,total_available,error,created_at`,
    [org, busca.id, token, creditos, gravadas, total, status, erro],
  );
  return rows[0]!;
}

export async function criarBusca(
  db: pg.Pool,
  admin: SupabaseClient,
  org: string,
  userId: string | null,
  requestId: string,
  nome: string,
  filtros: FiltrosB2b,
) {
  conferirFiltros(filtros);
  // Sem chave não cria linha nenhuma: a busca falharia sem nada a mostrar.
  await lerCredencial(db, admin, org, "cnpja");
  const criada = await db.query<LinhaDaBusca>(
    `insert into prospecting_b2b_searches(organization_id,request_id,name,filtros,created_by)
     values ($1,$2,$3,$4::jsonb,$5) on conflict (organization_id,request_id) do nothing
     returning id,name,filtros,status,next_token,credits_used,results_count,total_available,error,created_at`,
    [org, requestId, nome, JSON.stringify(filtros), userId],
  );
  if (!criada.rows[0]) {
    // Mesmo request_id: devolve a busca que já existe, sem pagar de novo.
    const { rows } = await db.query<LinhaDaBusca>(
      "select id,name,filtros,status,next_token,credits_used,results_count,total_available,error,created_at from prospecting_b2b_searches where organization_id=$1 and request_id=$2",
      [org, requestId],
    );
    return { busca: rows[0]!, repetida: true, creditos_estimados: creditosEstimados(filtros.max_resultados) };
  }
  const busca = await lerPaginas(db, admin, org, criada.rows[0]);
  return { busca, repetida: false, creditos_estimados: creditosEstimados(filtros.max_resultados) };
}

export async function carregarMais(db: pg.Pool, admin: SupabaseClient, org: string, id: string) {
  const { rows } = await db.query<LinhaDaBusca>(
    "select id,name,filtros,status,next_token,credits_used,results_count,total_available,error,created_at from prospecting_b2b_searches where organization_id=$1 and id=$2",
    [org, id],
  );
  const busca = rows[0];
  if (!busca) throw new ErroDaBuscaB2b("Busca não encontrada.", 404);
  if (!busca.next_token) throw new ErroDaBuscaB2b("Esta busca não tem mais resultados para carregar.", 409);
  // "Carregar mais" amplia o teto em mais um lote do mesmo tamanho, até o máximo.
  const filtros = {
    ...busca.filtros,
    max_resultados: Math.min(busca.results_count + busca.filtros.max_resultados, 5000),
  };
  return lerPaginas(db, admin, org, { ...busca, filtros });
}

export async function selecionar(
  db: pg.Pool,
  org: string,
  searchId: string,
  selecionada: boolean,
  ids: string[],
): Promise<number> {
  const { rowCount } = await db.query(
    "update prospecting_b2b_companies set selected=$3,updated_at=now() where organization_id=$1 and search_id=$2 and id=any($4::uuid[])",
    [org, searchId, selecionada, ids],
  );
  return rowCount ?? 0;
}

export async function listarBuscas(db: pg.Pool | pg.PoolClient, org: string) {
  const { rows } = await db.query(
    "select id,name,filtros,status,next_token is not null as tem_mais,credits_used,results_count,total_available,error,created_at from prospecting_b2b_searches where organization_id=$1 order by created_at desc limit 50",
    [org],
  );
  return rows;
}

export async function listarEmpresas(db: pg.Pool | pg.PoolClient, org: string, searchId: string) {
  const { rows } = await db.query(
    "select id,cnpj,data,selected,score,score_band from prospecting_b2b_companies where organization_id=$1 and search_id=$2 order by capital_social desc nulls last,razao_social limit 5000",
    [org, searchId],
  );
  return rows as Array<{ id: string; cnpj: string; data: EmpresaB2b; selected: boolean; score: number | null; score_band: string | null }>;
}

function celula(valor: unknown): string {
  const texto = valor === null || valor === undefined ? "" : String(valor);
  // Planilha executa fórmula que começa com = + - @: neutraliza (injeção de CSV).
  const seguro = /^[=+\-@\t\r]/.test(texto) ? `'${texto}` : texto;
  return /[";\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

const FAIXA_LEGIVEL: Record<string, string> = { alta: "alta", media: "média", baixa: "baixa" };
const STATUS_DO_EMAIL: Record<string, string> = {
  valid: "verificado",
  invalid: "inválido",
  catch_all: "domínio aceita tudo",
  risky: "arriscado",
  unknown: "não verificado",
};

/**
 * CSV com `;` (abre direto no Excel em português) e BOM UTF-8. Só as selecionadas.
 * Uma linha por DECISOR (a empresa se repete); empresa sem decisor sai numa linha
 * com as colunas do decisor vazias.
 */
export async function exportarCsv(
  db: pg.Pool | pg.PoolClient,
  org: string,
  searchId: string,
): Promise<{ csv: string; linhas: number; empresas: number; decisores: number }> {
  const empresas = (await listarEmpresas(db, org, searchId)).filter((e) => e.selected);
  const contatos = await listarContatos(db, org, searchId);
  const porEmpresa = new Map<string, typeof contatos>();
  for (const c of contatos) porEmpresa.set(c.company_id, [...(porEmpresa.get(c.company_id) ?? []), c]);
  const cabecalho = [
    "CNPJ", "Razão social", "Nome fantasia", "CNAE principal", "Atividade", "Porte", "Capital social",
    "Optante do Simples", "Natureza jurídica", "Cidade", "UF", "Aberta em", "Situação",
    "Telefones", "E-mails", "Domínio", "Nota do perfil (Jev)",
    "Decisor", "Cargo", "E-mail do decisor", "E-mail verificado?", "Celular do decisor", "LinkedIn",
  ];
  const linhas: string[] = [];
  let decisores = 0;
  for (const { id, data: e, score_band } of empresas) {
    const daEmpresa = [
      e.cnpj, e.razao_social, e.nome_fantasia, e.cnae_principal, e.cnae_principal_descricao, e.porte,
      e.capital_social, e.simples_optante === null ? "" : e.simples_optante ? "sim" : "não",
      e.natureza_juridica, e.cidade, e.uf, e.aberta_em, e.situacao,
      e.telefones.map((t) => `${t.numero} (${t.tipo})`).join(", "), e.emails.join(", "), e.dominio,
      score_band ? (FAIXA_LEGIVEL[score_band] ?? score_band) : "",
    ];
    const deles = porEmpresa.get(id) ?? [];
    if (!deles.length) linhas.push([...daEmpresa, "", "", "", "", "", ""].map(celula).join(";"));
    for (const c of deles) {
      decisores += 1;
      linhas.push(
        [
          ...daEmpresa,
          c.nome,
          c.cargo,
          c.email,
          c.email_status ? (STATUS_DO_EMAIL[c.email_status] ?? c.email_status) : "",
          c.telefone,
          c.linkedin_url,
        ]
          .map(celula)
          .join(";"),
      );
    }
  }
  return {
    csv: `\ufeff${[cabecalho.join(";"), ...linhas].join("\r\n")}\r\n`,
    linhas: linhas.length,
    empresas: empresas.length,
    decisores,
  };
}
