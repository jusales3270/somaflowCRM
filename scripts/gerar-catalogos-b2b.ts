/**
 * Gera os catálogos oficiais que a prospecção B2B embute:
 *   lib/prospecting/b2b/catalogos/cnae-subclasses.json — CNAE 2.3, subclasses (IBGE)
 *   lib/prospecting/b2b/catalogos/municipios.json      — municípios com código IBGE e UF
 *
 * Por que embutir e não consultar em tempo de execução: a busca por CNPJ filtra por
 * CÓDIGO (CNAE de 7 dígitos, município IBGE de 7 dígitos), e a sugestão de CNAE pela
 * IA só é aceita se o código existir no catálogo. Depender do IBGE no meio da busca
 * deixaria a tela refém de um serviço de fora — e a instalação self-host às vezes
 * nem alcança a internet aberta. O catálogo muda raramente (a CNAE 2.3 é de 2019).
 *
 * Rodar à mão e commitar a saída:  pnpm exec tsx scripts/gerar-catalogos-b2b.ts
 *
 * O servidor do IBGE manda a cadeia de certificado INCOMPLETA: o `fetch` do Node
 * recusa ("fetch failed"/"unable to verify the first certificate"), e o `curl` do
 * sistema operacional passa. Nesse caso, baixe com o curl e passe os arquivos:
 *   curl -s https://servicodados.ibge.gov.br/api/v2/cnae/subclasses -o /tmp/cnae.json
 *   curl -s https://servicodados.ibge.gov.br/api/v1/localidades/municipios -o /tmp/mun.json
 *   pnpm exec tsx scripts/gerar-catalogos-b2b.ts --de-arquivos /tmp/cnae.json /tmp/mun.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DESTINO = join(process.cwd(), "lib/prospecting/b2b/catalogos");
const IBGE = "https://servicodados.ibge.gov.br/api";

interface SubclasseIbge {
  id: string;
  descricao: string;
  classe?: { descricao?: string; grupo?: { divisao?: { descricao?: string } } };
}
interface MunicipioIbge {
  id: number;
  nome: string;
  microrregiao?: { mesorregiao?: { UF?: { sigla?: string } } };
  "regiao-imediata"?: { "regiao-intermediaria"?: { UF?: { sigla?: string } } };
}

const DE_ARQUIVOS = process.argv.indexOf("--de-arquivos");
const ARQUIVOS: Record<string, string | undefined> =
  DE_ARQUIVOS >= 0
    ? {
        "/v2/cnae/subclasses": process.argv[DE_ARQUIVOS + 1],
        "/v1/localidades/municipios": process.argv[DE_ARQUIVOS + 2],
      }
    : {};

async function json<T>(caminho: string): Promise<T> {
  const arquivo = ARQUIVOS[caminho];
  if (arquivo) return JSON.parse(readFileSync(arquivo, "utf8")) as T;
  const res = await fetch(`${IBGE}${caminho}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`IBGE ${caminho}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function main() {
  const subclasses = await json<SubclasseIbge[]>("/v2/cnae/subclasses");
  const cnae = subclasses
    .map((s) => ({
      c: s.id,
      d: s.descricao.trim(),
      // A classe ajuda a busca por palavra ("software" acha "programas de computador").
      cl: s.classe?.descricao?.trim() ?? "",
      // A divisão é onde mora a palavra genérica: "alimentos" só aparece em
      // "Fabricação de produtos alimentícios", nunca em "Fabricação de conservas".
      dv: s.classe?.grupo?.divisao?.descricao?.trim() ?? "",
    }))
    .filter((s) => /^\d{7}$/.test(s.c))
    .sort((a, b) => a.c.localeCompare(b.c));

  const municipios = (await json<MunicipioIbge[]>("/v1/localidades/municipios"))
    .map((m) => ({
      i: m.id,
      n: m.nome,
      u:
        m.microrregiao?.mesorregiao?.UF?.sigla ??
        m["regiao-imediata"]?.["regiao-intermediaria"]?.UF?.sigla ??
        "",
    }))
    .filter((m) => /^[A-Z]{2}$/.test(m.u))
    .sort((a, b) => a.u.localeCompare(b.u) || a.n.localeCompare(b.n, "pt-BR"));

  mkdirSync(DESTINO, { recursive: true });
  writeFileSync(join(DESTINO, "cnae-subclasses.json"), `${JSON.stringify(cnae)}\n`);
  writeFileSync(join(DESTINO, "municipios.json"), `${JSON.stringify(municipios)}\n`);
  process.stdout.write(`cnae-subclasses: ${cnae.length} | municipios: ${municipios.length}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
