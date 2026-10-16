/**
 * PROSPECÇÃO B2B POR CNPJ (migration 9002) — num Postgres real com o baseline.
 *
 *   1. As três tabelas só a service role alcança: anon e authenticated não leem
 *      nem escrevem (nem a chave cifrada, nem a lista de empresas).
 *   2. A função de expurgo é revogada de anon/authenticated e tem o piso de 90 dias
 *      no CORPO: pedir 1 dia não apaga busca de 30 dias.
 *   3. Apagar a busca vencida leva as empresas dela (cascata), e a busca recente
 *      fica.
 *   4. Isolamento: as consultas filtram por organização — a busca de B não aparece
 *      no filtro de A.
 *   5. CNPJ fora do formato é recusado pelo próprio banco.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG_A = "90020000-0000-4000-8000-00000000000a";
const ORG_B = "90020000-0000-4000-8000-00000000000b";
const VELHA = "90020000-1111-4000-8000-000000000001";
const NOVA = "90020000-1111-4000-8000-000000000002";
const DE_B = "90020000-1111-4000-8000-000000000003";

function conta(query: string): number {
  return Number(lastLine(sql(query)));
}

beforeEach(() => {
  sql(`
    insert into organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'org-b2b-a', 'Org B2B A LTDA', 'Org B2B A'),
      ('${ORG_B}', 'org-b2b-b', 'Org B2B B LTDA', 'Org B2B B')
      on conflict (id) do nothing;
    delete from prospecting_b2b_searches where organization_id in ('${ORG_A}', '${ORG_B}');
    insert into prospecting_b2b_searches (id, organization_id, request_id, name, filtros, created_at) values
      ('${VELHA}', '${ORG_A}', gen_random_uuid(), 'Busca de 400 dias', '{}'::jsonb, now() - interval '400 days'),
      ('${NOVA}', '${ORG_A}', gen_random_uuid(), 'Busca de 30 dias', '{}'::jsonb, now() - interval '30 days'),
      ('${DE_B}', '${ORG_B}', gen_random_uuid(), 'Busca de B', '{}'::jsonb, now());
    insert into prospecting_b2b_companies (organization_id, search_id, cnpj, razao_social, data) values
      ('${ORG_A}', '${VELHA}', '11111111000111', 'Velha LTDA', '{}'::jsonb),
      ('${ORG_A}', '${NOVA}', '22222222000122', 'Nova LTDA', '{}'::jsonb),
      ('${ORG_B}', '${DE_B}', '33333333000133', 'De B LTDA', '{}'::jsonb);
  `);
});

describe("prospecção B2B — acesso só pela service role", () => {
  it.each([
    "prospecting_provider_credentials",
    "prospecting_b2b_searches",
    "prospecting_b2b_companies",
  ])("%s: anon e authenticated sem SELECT, INSERT, UPDATE nem DELETE", (tabela) => {
    for (const papel of ["anon", "authenticated"]) {
      for (const privilegio of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(
          lastLine(sql(`select has_table_privilege('${papel}', 'public.${tabela}', '${privilegio}');`)),
          `${papel} ${privilegio} ${tabela}`,
        ).toBe("f");
      }
    }
    expect(lastLine(sql(`select relrowsecurity from pg_class where oid = 'public.${tabela}'::regclass;`))).toBe("t");
  });

  it("a função de expurgo não é alcançável por anon nem authenticated", () => {
    const assinatura = "public.fn_expurgar_prospeccao_b2b_vencida(int, int)";
    expect(lastLine(sql(`select has_function_privilege('anon', '${assinatura}', 'execute');`))).toBe("f");
    expect(lastLine(sql(`select has_function_privilege('authenticated', '${assinatura}', 'execute');`))).toBe("f");
    expect(lastLine(sql(`select has_function_privilege('service_role', '${assinatura}', 'execute');`))).toBe("t");
  });
});

describe("prospecção B2B — expurgo", () => {
  it("pedir 1 dia vira o piso de 90: só a busca de 400 dias sai, com as empresas dela", () => {
    const apagadas = conta(`select public.fn_expurgar_prospeccao_b2b_vencida(1, 1000);`);
    expect(apagadas).toBe(1);
    expect(conta(`select count(*) from prospecting_b2b_searches where id = '${VELHA}';`)).toBe(0);
    expect(conta(`select count(*) from prospecting_b2b_companies where search_id = '${VELHA}';`)).toBe(0);
    expect(conta(`select count(*) from prospecting_b2b_searches where id in ('${NOVA}', '${DE_B}');`)).toBe(2);
    expect(conta(`select count(*) from prospecting_b2b_companies where search_id = '${NOVA}';`)).toBe(1);
  });
});

describe("prospecção B2B — dados", () => {
  it("o filtro por organização não mistura buscas", () => {
    expect(conta(`select count(*) from prospecting_b2b_searches where organization_id = '${ORG_A}';`)).toBe(2);
    expect(
      conta(`select count(*) from prospecting_b2b_companies where organization_id = '${ORG_A}' and cnpj = '33333333000133';`),
    ).toBe(0);
  });

  it("CNPJ fora do formato é recusado pelo banco", () => {
    expect(() =>
      sql(`insert into prospecting_b2b_companies (organization_id, search_id, cnpj, razao_social, data)
           values ('${ORG_A}', '${NOVA}', '123', 'Inválida', '{}'::jsonb);`),
    ).toThrow();
  });

  it("a mesma empresa não entra duas vezes na mesma busca", () => {
    expect(() =>
      sql(`insert into prospecting_b2b_companies (organization_id, search_id, cnpj, razao_social, data)
           values ('${ORG_A}', '${NOVA}', '22222222000122', 'Repetida', '{}'::jsonb);`),
    ).toThrow();
  });
});
