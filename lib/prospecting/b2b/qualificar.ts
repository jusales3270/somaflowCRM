/**
 * Nota de aderência ao perfil ideal, pelo Jev, para as empresas de uma busca B2B.
 *
 * O perfil ideal é o que a pessoa descreveu na busca (`filtros.descricao`) mais os
 * filtros que ela escolheu. Cada empresa vira UMA pergunta `score` de três níveis
 * ordenados (baixa → média → alta), e até `POR_CHAMADA` empresas vão na mesma
 * chamada: o estado é compartilhado (`{ perfil_ideal, empresas: { <cnpj>: … } }`)
 * e cada pergunta nomeia a sua empresa pelo CNPJ.
 *
 * O que sai para o Jev: só dado PÚBLICO de pessoa jurídica da Receita (atividade,
 * porte, capital social, natureza, cidade, abertura) — nunca telefone, e-mail ou
 * decisor.
 *
 * Quem pede é o botão "Qualificar com o Jev" da lista: o liga/desliga do Jev nas
 * conversas não se aplica (`ADERENCIA_B2B` em `lib/ai/decisao/tarefas.ts`). Sem
 * chave do Jev na organização, a tela diz onde cadastrar. Custo e falha viram
 * linha em `llm_calls` (Uso de IA e IA › Execuções), como as outras chamadas do Jev.
 */
import type pg from "pg";

import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
import { MODELO_DO_JEV, type Pergunta, type ResultadoDaDecisao } from "@/lib/ai/decisao/cliente";
import { PROVEDOR_DO_JEV } from "@/lib/ai/decisao/credencial";
import { podeTentar, registrarFalha, registrarSucesso } from "@/lib/ai/decisao/disjuntor";
import { decidirNoPonto, type DependenciasDoPonto } from "@/lib/ai/decisao/ponto";
import { ADERENCIA_B2B } from "@/lib/ai/decisao/tarefas";
import { codigoDoErroDoJev } from "@/lib/ai/decisao/textos";
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";
import { cnaePorCodigo, descricaoLegivel, municipioPorCodigo } from "./catalogos";
import type { EmpresaB2b, FiltrosB2b } from "./schema";

export const POR_CHAMADA = 10;
const TETO_MS = 30_000;

/** Os três níveis, do pior para o melhor (a ordem é o contrato do `score`). */
export const NIVEIS_DE_ADERENCIA = [
  "baixa — a empresa provavelmente não tem o perfil descrito",
  "média — a empresa tem parte do perfil, ou faltam dados para dizer",
  "alta — a empresa tem o perfil descrito",
] as const;
export const FAIXAS = ["baixa", "media", "alta"] as const;
export type Faixa = (typeof FAIXAS)[number];

export class ErroDaQualificacao extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = "ErroDaQualificacao";
  }
}

const MENSAGEM_DO_MOTIVO: Record<string, string> = {
  sem_credencial: "Cadastre a chave do Jev em IA › Provedores para dar nota às empresas.",
  credencial_invalida: "A chave do Jev foi recusada. Confira-a em IA › Provedores.",
  sem_credito: "A conta do Jev está sem crédito. Recarregue e tente de novo.",
  limite_de_taxa: "O Jev pediu uma pausa. Tente de novo em instantes.",
  provedor_sobrecarregado: "O Jev está sobrecarregado agora. Tente de novo em instantes.",
  provedor_indisponivel: "O Jev não respondeu. Tente de novo em instantes.",
  disjuntor_aberto: "O Jev falhou várias vezes seguidas; a nota volta a ser pedida em alguns minutos.",
  resposta_ilegivel: "O Jev devolveu uma resposta que não deu para ler. Tente de novo.",
  contrato_invalido: "A pergunta ao Jev foi recusada. Avise o suporte.",
};

/** O que vai no estado: dado público de pessoa jurídica, nada de contato. */
export function fichaPublica(e: EmpresaB2b): Record<string, unknown> {
  return {
    razao_social: e.razao_social,
    nome_fantasia: e.nome_fantasia,
    atividade_principal: e.cnae_principal_descricao ?? (e.cnae_principal ? cnaePorCodigo(e.cnae_principal)?.d : null),
    atividades_secundarias: e.cnaes_secundarios
      .slice(0, 8)
      .map((c) => cnaePorCodigo(c)?.d)
      .filter(Boolean)
      .map((d) => descricaoLegivel(d!)),
    porte: e.porte,
    capital_social_reais: e.capital_social,
    optante_do_simples: e.simples_optante,
    natureza_juridica: e.natureza_juridica,
    cidade: e.cidade && e.uf ? `${e.cidade}/${e.uf}` : e.cidade,
    aberta_em: e.aberta_em,
  };
}

export function perfilIdeal(f: FiltrosB2b): Record<string, unknown> {
  return {
    descricao: f.descricao || null,
    atividades_buscadas: f.cnaes.map((c) => (cnaePorCodigo(c) ? descricaoLegivel(cnaePorCodigo(c)!.d) : c)),
    onde: f.municipios.length
      ? f.municipios.map((m) => {
          const x = municipioPorCodigo(m);
          return x ? `${x.n}/${x.u}` : String(m);
        })
      : f.ufs,
    faturamento: f.portes.includes(5) && f.portes.length === 1 ? "acima de R$ 4,8 milhões por ano" : "qualquer porte escolhido",
    fora_do_simples: f.nao_optante_simples,
  };
}

export function idDaPergunta(cnpj: string): string {
  return `aderencia_${cnpj}`;
}

export function perguntasDoLote(empresas: Array<{ cnpj: string; data: EmpresaB2b }>): Record<string, Pergunta> {
  const perguntas: Record<string, Pergunta> = {};
  for (const { cnpj, data } of empresas) {
    perguntas[idDaPergunta(cnpj)] = {
      tipo: "score",
      instrucao: `Quão perto do perfil_ideal está a empresa ${data.nome_fantasia || data.razao_social} (CNPJ ${cnpj}, em empresas.${cnpj}), pela atividade, porte, capital social, natureza jurídica e tempo de existência? Considere que o faturamento de empresa privada não é público: o porte e o capital social são indícios.`,
      criterios: NIVEIS_DE_ADERENCIA,
    };
  }
  return perguntas;
}

export interface Nota {
  score: number;
  faixa: Faixa;
  confianca: number | null;
}

/** A resposta `score` (0..2) vira nota 0..1 e faixa; fora disso é ilegível (`null`). */
export function notaDaResposta(resposta: unknown): Nota | null {
  const r = resposta as { tipo?: unknown; score?: unknown; probabilidades?: unknown; confianca?: unknown } | null;
  if (!r || r.tipo !== "score" || typeof r.score !== "number" || !Number.isFinite(r.score)) return null;
  if (r.score < 0 || r.score > NIVEIS_DE_ADERENCIA.length - 1) return null;
  let indice = Math.round(r.score);
  // O Jev devolve as probabilidades por NÍVEL, como objeto (`{"0":0.01,"1":0.03,"2":0.96}`
  // — medido na API real em 16/10/2026); a faixa é a do nível mais provável.
  const p = r.probabilidades;
  if (p && typeof p === "object") {
    const niveis = NIVEIS_DE_ADERENCIA.map((_, i) => (p as Record<string, unknown>)[String(i)]);
    if (niveis.every((x) => typeof x === "number" && Number.isFinite(x))) {
      const valores = niveis as number[];
      indice = valores.indexOf(Math.max(...valores));
    }
  }
  return {
    score: Math.round((r.score / (NIVEIS_DE_ADERENCIA.length - 1)) * 1000) / 1000,
    faixa: FAIXAS[indice]!,
    confianca: typeof r.confianca === "number" && Number.isFinite(r.confianca) ? r.confianca : null,
  };
}

/** A chave do Jev da organização (a mais nova, ativa e validada) — `null` sem ela. */
async function chaveDoJev(db: pg.Pool, org: string): Promise<string | null> {
  try {
    const { rows } = await db.query<{ api_key_encrypted: unknown; api_key_iv: unknown; api_key_tag: unknown }>(
      `select api_key_encrypted,api_key_iv,api_key_tag from ai_provider_credentials
        where organization_id=$1 and provider=$2 and is_active and validated_at is not null
        order by created_at desc limit 1`,
      [org, PROVEDOR_DO_JEV],
    );
    const c = rows[0];
    if (!c) return null;
    return decryptKey({
      ciphertext: byteaToBuffer(c.api_key_encrypted),
      iv: byteaToBuffer(c.api_key_iv),
      tag: byteaToBuffer(c.api_key_tag),
    });
  } catch (e) {
    logger.warn("[prospeccao-b2b] chave do Jev não pôde ser lida", {
      organization_id: org,
      erro: e instanceof Error ? e.name : typeof e,
    });
    return null;
  }
}

export async function jevConfigurado(db: pg.Pool, org: string): Promise<boolean> {
  const { rows } = await db.query(
    "select 1 from ai_provider_credentials where organization_id=$1 and provider=$2 and is_active and validated_at is not null limit 1",
    [org, PROVEDOR_DO_JEV],
  );
  return rows.length > 0;
}

async function gravarChamada(
  db: pg.Pool,
  org: string,
  r: ResultadoDaDecisao,
): Promise<void> {
  try {
    if (r.ok) {
      await db.query(
        `insert into llm_calls (organization_id,purpose,provider,model,input_tokens,output_tokens,cost_cents,latency_ms,status,origem_da_escolha)
         values ($1,$2,'typesafe',$3,$4,$5,$6,$7,'ok','jev')`,
        [
          org,
          ADERENCIA_B2B.purpose,
          `typesafe/${r.modelo}`,
          r.uso.tokensDeEntrada,
          r.uso.tokensDeSaida,
          costCents(r.modelo, {
            inputTokens: r.uso.tokensDeEntrada,
            outputTokens: r.uso.tokensDeSaida,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          }),
          r.latenciaMs,
        ],
      );
    } else {
      await db.query(
        `insert into llm_calls (organization_id,purpose,provider,model,input_tokens,output_tokens,cost_cents,latency_ms,status,error_code,http_status,origem_da_escolha)
         values ($1,$2,'typesafe',$3,0,0,0,$4,'erro',$5,$6,'jev')`,
        [org, ADERENCIA_B2B.purpose, `typesafe/${MODELO_DO_JEV}`, r.latenciaMs ?? null, codigoDoErroDoJev(r.motivo), r.status],
      );
    }
  } catch (e) {
    logger.warn("[prospeccao-b2b] chamada do Jev não foi registrada", {
      organization_id: org,
      erro: e instanceof Error ? e.message.slice(0, 200) : String(e),
    });
  }
}

export interface ResultadoDaQualificacao {
  avaliadas: number;
  faltam: number;
  chamadas: number;
}

/**
 * Dá nota às empresas ainda sem nota da busca, em lotes de `POR_CHAMADA`, até
 * `maximo` empresas por pedido. Lança `ErroDaQualificacao` quando o Jev não pode
 * ser usado (sem chave, chave recusada, sem crédito, disjuntor aberto) — o que já
 * recebeu nota fica.
 */
export async function qualificarBusca(
  db: pg.Pool,
  org: string,
  searchId: string,
  maximo = 50,
  deps: DependenciasDoPonto = {},
): Promise<ResultadoDaQualificacao> {
  const busca = await db.query<{ filtros: FiltrosB2b }>(
    "select filtros from prospecting_b2b_searches where organization_id=$1 and id=$2",
    [org, searchId],
  );
  if (!busca.rows[0]) throw new ErroDaQualificacao("Busca não encontrada.", 404);
  const perfil = perfilIdeal(busca.rows[0].filtros);
  const alvo = { organizationId: org, tarefa: ADERENCIA_B2B.purpose };
  let avaliadas = 0;
  let chamadas = 0;

  while (avaliadas < maximo) {
    const { rows: lote } = await db.query<{ id: string; cnpj: string; data: EmpresaB2b }>(
      `select id,cnpj,data from prospecting_b2b_companies
        where organization_id=$1 and search_id=$2 and scored_at is null
        order by capital_social desc nulls last, razao_social limit $3`,
      [org, searchId, Math.min(POR_CHAMADA, maximo - avaliadas)],
    );
    if (!lote.length) break;
    if (!podeTentar(alvo)) throw new ErroDaQualificacao(MENSAGEM_DO_MOTIVO.disjuntor_aberto!, 503);

    const empresas: Record<string, unknown> = {};
    for (const e of lote) empresas[e.cnpj] = fichaPublica(e.data);
    const r = await decidirNoPonto(
      { organizationId: org, estado: { perfil_ideal: perfil, empresas }, perguntas: perguntasDoLote(lote), tetoMs: TETO_MS },
      { ...deps, buscarChave: deps.buscarChave ?? ((o) => chaveDoJev(db, o)) },
    );
    chamadas += 1;
    await gravarChamada(db, org, r);
    if (!r.ok) {
      if (r.motivo !== "sem_credencial") registrarFalha(alvo, r.motivo, Date.now(), r.retryAfterMs);
      throw new ErroDaQualificacao(MENSAGEM_DO_MOTIVO[r.motivo] ?? MENSAGEM_DO_MOTIVO.provedor_indisponivel!, r.motivo === "sem_credencial" ? 422 : 502);
    }
    const notas = lote.map((e) => ({ id: e.id, nota: notaDaResposta(r.respostas[idDaPergunta(e.cnpj)]) }));
    if (notas.some((n) => !n.nota)) {
      registrarFalha(alvo, "resposta_ilegivel", Date.now());
      throw new ErroDaQualificacao(MENSAGEM_DO_MOTIVO.resposta_ilegivel!, 502);
    }
    registrarSucesso(alvo);
    await db.query(
      `update prospecting_b2b_companies c
          set score=(n->>'score')::numeric, score_band=n->>'faixa', score_confianca=(n->>'confianca')::numeric,
              scored_at=now(), updated_at=now()
         from jsonb_array_elements($3::jsonb) n
        where c.organization_id=$1 and c.search_id=$2 and c.id=(n->>'id')::uuid`,
      [org, searchId, JSON.stringify(notas.map((n) => ({ id: n.id, ...n.nota })))],
    );
    avaliadas += lote.length;
  }
  const { rows } = await db.query<{ n: number }>(
    "select count(*)::int as n from prospecting_b2b_companies where organization_id=$1 and search_id=$2 and scored_at is null",
    [org, searchId],
  );
  return { avaliadas, faltam: rows[0]?.n ?? 0, chamadas };
}
