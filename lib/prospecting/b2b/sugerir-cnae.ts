/**
 * "Descreva o tipo de empresa" → CNAEs possíveis.
 *
 * Três passos, e o terceiro é o que garante o resultado:
 *   1. busca por palavras no catálogo oficial (`buscarCnaes`) → uma lista curta;
 *   2. a IA da organização escolhe e ordena dessa lista, com o motivo de cada um
 *      (mesmo caminho de modelo da montagem de agente da prospecção:
 *      `resolveSetupModel` + `runModelCall`, custo em `llm_calls`);
 *   3. TODO código devolvido é conferido contra o catálogo — código que não
 *      existe é descartado, nunca mostrado.
 *
 * Nunca lança: sem IA configurada (ou se ela falhar), devolve a busca por
 * palavras, e a pessoa continua podendo procurar no catálogo à mão.
 *
 * O Jev (TypeSafe) não serve aqui: ele escolhe entre opções que você já tem, não
 * lê uma descrição livre — entra depois, na qualificação das empresas.
 */
import type pg from "pg";

import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { resolveSetupModel } from "../agent-setup";
import { buscarCnaes, cnaePorCodigo, descricaoLegivel, preListaParaIa, type Cnae } from "./catalogos";

export const PONTO_SUGESTAO_DE_CNAE = "prospecting_b2b_cnae_suggest";
const MAXIMO_SUGERIDO = 12;

export interface CnaeSugerido {
  codigo: string;
  descricao: string;
  motivo: string | null;
}

export interface SugestaoDeCnae {
  sugeridos: CnaeSugerido[];
  /** `ia` quando a IA escolheu; `palavras` quando só a busca por palavra respondeu. */
  origem: "ia" | "palavras";
  modelo: string | null;
}

const SISTEMA = `Você classifica tipos de empresa na CNAE 2.3 (subclasses, 7 dígitos) do IBGE.
Recebe a descrição de um perfil de empresa e uma lista de subclasses candidatas.
Responda SOMENTE com JSON: {"cnaes":[{"codigo":"0000000","motivo":"frase curta"}]}.
Escolha até ${MAXIMO_SUGERIDO}, da mais provável para a menos. Prefira a lista; só use um código fora dela se tiver certeza de que existe na CNAE 2.3. Não invente códigos.`;

function porPalavras(descricao: string): CnaeSugerido[] {
  return buscarCnaes(descricao, MAXIMO_SUGERIDO).map((c) => ({
    codigo: c.c,
    descricao: descricaoLegivel(c.d),
    motivo: null,
  }));
}

/** Lê o JSON da resposta e fica só com códigos do catálogo, sem repetir. Puro. */
export function codigosDaResposta(texto: string): Array<{ codigo: string; motivo: string | null }> {
  const inicio = texto.indexOf("{");
  const fim = texto.lastIndexOf("}");
  if (inicio < 0 || fim <= inicio) return [];
  let corpo: unknown;
  try {
    corpo = JSON.parse(texto.slice(inicio, fim + 1));
  } catch {
    return [];
  }
  const lista = (corpo as { cnaes?: unknown })?.cnaes;
  if (!Array.isArray(lista)) return [];
  const vistos = new Set<string>();
  const saida: Array<{ codigo: string; motivo: string | null }> = [];
  for (const item of lista) {
    const codigo = String((item as { codigo?: unknown })?.codigo ?? "").replace(/\D/g, "");
    if (!cnaePorCodigo(codigo) || vistos.has(codigo)) continue;
    vistos.add(codigo);
    const motivo = (item as { motivo?: unknown })?.motivo;
    saida.push({ codigo, motivo: typeof motivo === "string" ? motivo.slice(0, 200) : null });
    if (saida.length >= MAXIMO_SUGERIDO) break;
  }
  return saida;
}

export async function sugerirCnaes(
  pool: pg.Pool,
  org: string,
  descricao: string,
  oferece: (provider: string) => boolean,
): Promise<SugestaoDeCnae> {
  const candidatos: Cnae[] = preListaParaIa(descricao);
  let modelo: Awaited<ReturnType<typeof resolveSetupModel>>;
  const db = await pool.connect();
  try {
    modelo = await resolveSetupModel(db, org, null, oferece);
  } catch {
    // Sem modelo de IA configurado: a busca por palavras responde sozinha.
    return { sugeridos: porPalavras(descricao), origem: "palavras", modelo: null };
  } finally {
    db.release();
  }
  try {
    const { result } = await runModelCall(pool, llmEdgeConfigFromEnv(env), {
      tenantId: org,
      purpose: "prospecting_b2b_cnae_suggest", // = PONTO_SUGESTAO_DE_CNAE (a varredura de pontos lê o literal)
      model: modelo.model,
      llmOverride: { provider: modelo.provider, credentialId: modelo.credential_id },
      maxSteps: 1,
      maxOutputTokens: 900,
      system: SISTEMA,
      messages: [
        {
          role: "user",
          content: `PERFIL: ${descricao}\n\nCANDIDATAS (código — descrição):\n${candidatos
            .map((c) => `${c.c} — ${descricaoLegivel(c.d)}`)
            .join("\n")}`,
        },
      ],
    });
    const escolhidos = codigosDaResposta(result.text ?? "");
    if (!escolhidos.length) return { sugeridos: porPalavras(descricao), origem: "palavras", modelo: modelo.label };
    return {
      sugeridos: escolhidos.map(({ codigo, motivo }) => ({
        codigo,
        descricao: descricaoLegivel(cnaePorCodigo(codigo)!.d),
        motivo,
      })),
      origem: "ia",
      modelo: modelo.label,
    };
  } catch (e) {
    logger.warn("[prospeccao-b2b] sugestão de CNAE pela IA falhou — usando a busca por palavras", {
      organization_id: org,
      error: e instanceof Error ? e.message : String(e),
    });
    return { sugeridos: porPalavras(descricao), origem: "palavras", modelo: modelo.label };
  }
}
