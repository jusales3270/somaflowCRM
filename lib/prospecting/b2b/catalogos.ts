/**
 * Os catálogos oficiais da prospecção B2B: CNAE 2.3 (subclasses) e municípios,
 * os dois do IBGE, embutidos em `./catalogos/*.json` (gerador:
 * `scripts/gerar-catalogos-b2b.ts`).
 *
 * São a régua de VALIDAÇÃO: a busca por CNPJ filtra por código, e um código que a
 * IA sugerir ou que chegar no corpo da requisição só vale se existir aqui. Só o
 * servidor importa este módulo — os JSON não vão para o bundle do navegador; a tela
 * os consulta por `GET /api/v1/prospecting/b2b/catalogos`.
 */
import "server-only";

import cnaeBruto from "./catalogos/cnae-subclasses.json";
import municipiosBruto from "./catalogos/municipios.json";

export interface Cnae {
  /** Subclasse, 7 dígitos (ex.: "6201501"). */
  c: string;
  /** Descrição oficial da subclasse. */
  d: string;
  /** Descrição da classe — ajuda a busca por palavra. */
  cl: string;
  /** Descrição da divisão (2 dígitos) — onde mora a palavra genérica ("alimentícios"). */
  dv: string;
}

export interface Municipio {
  /** Código IBGE, 7 dígitos. */
  i: number;
  n: string;
  u: string;
}

export const CNAES: readonly Cnae[] = cnaeBruto as Cnae[];
export const MUNICIPIOS: readonly Municipio[] = municipiosBruto as Municipio[];

export const UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA",
  "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
] as const;
export type Uf = (typeof UFS)[number];

const CNAE_POR_CODIGO = new Map(CNAES.map((c) => [c.c, c]));
const MUNICIPIO_POR_CODIGO = new Map(MUNICIPIOS.map((m) => [m.i, m]));

export function cnaePorCodigo(codigo: string): Cnae | undefined {
  return CNAE_POR_CODIGO.get(codigo.replace(/\D/g, ""));
}

export function municipioPorCodigo(codigo: number): Municipio | undefined {
  return MUNICIPIO_POR_CODIGO.get(codigo);
}

/** Minúsculas, sem acento e sem pontuação — para comparar palavra com palavra. */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Palavras que não ajudam a achar atividade nenhuma. */
const VAZIAS = new Set(
  "a o as os de da do das dos e em para por com sem um uma que no na nos nas ao aos empresa empresas servico servicos atividade atividades outros outras nao especificadas anteriormente sob exceto geral industria comercio".split(
    " ",
  ),
);

function palavras(texto: string): string[] {
  return normalizar(texto)
    .split(" ")
    .filter((p) => p.length >= 3 && !VAZIAS.has(p));
}

/** Radical de 4 a 6 letras: "transportadora" acha "transporte"; "construtora", "construção". */
function radical(termo: string): string {
  return termo.slice(0, Math.max(4, Math.min(6, termo.length - 1)));
}

/** A primeira palavra que significa algo — o núcleo da atividade ("transporte", "construção"). */
function nucleo(palavrasDaDescricao: string[]): string | undefined {
  return palavrasDaDescricao.find((p) => p.length >= 3 && !VAZIAS.has(p));
}

/**
 * Busca por palavras na descrição da subclasse e da classe. Cada palavra do texto
 * que aparece (pelo radical) soma ponto; vale mais na descrição da própria
 * subclasse, e mais ainda quando é o NÚCLEO da atividade (a primeira palavra que
 * significa algo). Devolve do mais aderente para o menos.
 *
 * `estrito` (o padrão, para o que a pessoa vê): só fica quem pontua ao menos
 * metade do melhor — "software sob encomenda" não traz "matadouro sob contrato".
 * A pré-lista que a IA recebe usa `estrito: false`: ali importa não perder a
 * atividade certa, e quem escolhe é a IA.
 */
export function buscarCnaes(texto: string, limite = 30, { estrito = true } = {}): Cnae[] {
  const termos = palavras(texto).map(radical);
  const codigo = texto.replace(/\D/g, "");
  if (codigo.length >= 4) {
    const porCodigo = CNAES.filter((c) => c.c.startsWith(codigo));
    if (porCodigo.length) return porCodigo.slice(0, limite);
  }
  if (!termos.length) return [];
  const pontuados: Array<{ cnae: Cnae; pontos: number }> = [];
  for (const cnae of CNAES) {
    const dSub = normalizar(cnae.d).split(" ");
    const dClasse = normalizar(cnae.cl).split(" ");
    const dDivisao = normalizar(cnae.dv).split(" ");
    const nucleoDaSub = nucleo(dSub);
    let pontos = 0;
    for (const raiz of termos) {
      if (nucleoDaSub?.startsWith(raiz)) pontos += 5;
      else if (dSub.some((p) => p.startsWith(raiz))) pontos += 3;
      else if (dClasse.some((p) => p.startsWith(raiz))) pontos += 1;
      else if (dDivisao.some((p) => p.startsWith(raiz))) pontos += 1;
    }
    if (pontos > 0) pontuados.push({ cnae, pontos });
  }
  const melhor = Math.max(0, ...pontuados.map((p) => p.pontos));
  return pontuados
    .filter((p) => !estrito || p.pontos * 2 >= melhor)
    .sort((a, b) => b.pontos - a.pontos || a.cnae.c.localeCompare(b.cnae.c))
    .slice(0, limite)
    .map((p) => p.cnae);
}

/**
 * A pré-lista que a IA recebe para escolher: cada palavra do texto ganha o seu
 * quinhão de vagas, e só então tudo se junta pela pontuação. Sem isto, "alimentos
 * e bebidas" enchia as vagas com as dezenas de subclasses de alimentos (empatadas)
 * e as de bebidas nunca chegavam à IA.
 */
export function preListaParaIa(texto: string, limite = 120): Cnae[] {
  const termos = [...new Set(palavras(texto))];
  if (!termos.length || texto.replace(/\D/g, "").length >= 4) return buscarCnaes(texto, limite, { estrito: false });
  const geral = buscarCnaes(texto, CNAES.length, { estrito: false });
  const posicao = new Map(geral.map((c, i) => [c.c, i]));
  const quinhao = Math.max(10, Math.ceil(limite / termos.length));
  const escolhidos = new Set<string>();
  for (const termo of termos) {
    for (const c of buscarCnaes(termo, quinhao, { estrito: false })) escolhidos.add(c.c);
  }
  for (const c of geral) {
    if (escolhidos.size >= limite) break;
    escolhidos.add(c.c);
  }
  return [...escolhidos]
    .sort((a, b) => (posicao.get(a) ?? 1e9) - (posicao.get(b) ?? 1e9))
    .slice(0, limite)
    .map((c) => cnaePorCodigo(c)!);
}

/** Municípios por nome, opcionalmente dentro das UFs escolhidas. */
export function buscarMunicipios(texto: string, ufs: readonly string[] = [], limite = 30): Municipio[] {
  const alvo = normalizar(texto);
  const dentro = ufs.length ? MUNICIPIOS.filter((m) => ufs.includes(m.u)) : MUNICIPIOS;
  if (!alvo) return dentro.slice(0, limite);
  const comeca: Municipio[] = [];
  const contem: Municipio[] = [];
  for (const m of dentro) {
    const nome = normalizar(m.n);
    if (nome.startsWith(alvo)) comeca.push(m);
    else if (nome.includes(alvo)) contem.push(m);
  }
  // Nome exato primeiro, depois o mais curto: "campin" acha Campinas antes de
  // "Campina do Monte Alegre".
  comeca.sort((a, b) => Number(normalizar(b.n) === alvo) - Number(normalizar(a.n) === alvo) || a.n.length - b.n.length);
  return [...comeca, ...contem].slice(0, limite);
}

/** "DESENVOLVIMENTO DE PROGRAMAS…" → "Desenvolvimento de programas…" (leitura). */
export function descricaoLegivel(descricao: string): string {
  const minusculo = descricao.toLowerCase();
  return minusculo.charAt(0).toUpperCase() + minusculo.slice(1);
}
