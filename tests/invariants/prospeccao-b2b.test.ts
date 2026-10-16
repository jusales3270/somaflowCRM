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
 *
 * E a 9003 (decisores pelo Treg, nota do Jev, custo dos provedores):
 *   6. As cinco tabelas novas também só pela service role — e um usuário logado
 *      (JWT de authenticated) é recusado em TODAS as oito, das duas organizações.
 *   7. fn_custo_dos_provedores e fn_expurgar_contatos_b2b_vencidos: só service_role.
 *   8. O custo do Treg (US$) vira R$ pela PTAX do DIA de cada consulta; a CNPJá
 *      entra pelo R$ gravado; a organização B não entra na conta de A.
 *   9. O decisor vencido (180 dias) sai no expurgo; o válido fica.
 *  10. Apagar a busca leva rodadas, livro-caixa e decisores (cascata); o mesmo
 *      decisor não entra duas vezes na mesma empresa.
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

const TABELAS = [
  "prospecting_provider_credentials",
  "prospecting_b2b_searches",
  "prospecting_b2b_companies",
  "prospecting_b2b_enrichment_runs",
  "prospecting_b2b_enrichment_items",
  "prospecting_b2b_contacts",
  "prospecting_b2b_suppressions",
  "prospecting_provider_costs",
] as const;

describe("prospecção B2B — acesso só pela service role", () => {
  it.each(TABELAS)("%s: anon e authenticated sem SELECT, INSERT, UPDATE nem DELETE", (tabela) => {
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

  it.each([
    "public.fn_expurgar_prospeccao_b2b_vencida(int, int)",
    "public.fn_expurgar_contatos_b2b_vencidos(int, int)",
    "public.fn_custo_dos_provedores(uuid, timestamptz, timestamptz)",
  ])("%s não é alcançável por anon nem authenticated", (assinatura) => {
    expect(lastLine(sql(`select has_function_privilege('anon', '${assinatura}', 'execute');`))).toBe("f");
    expect(lastLine(sql(`select has_function_privilege('authenticated', '${assinatura}', 'execute');`))).toBe("f");
    expect(lastLine(sql(`select has_function_privilege('service_role', '${assinatura}', 'execute');`))).toBe("t");
  });

  it.each(TABELAS)("%s: um usuário logado (JWT) é recusado, nas duas organizações", (tabela) => {
    for (const org of [ORG_A, ORG_B]) {
      expect(() =>
        sql(`set role authenticated;
          select set_config('request.jwt.claims', '{"sub":"90020000-2222-4000-8000-000000000099"}', false);
          select count(*) from public.${tabela} where organization_id = '${org}';`),
      ).toThrow();
    }
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

describe("prospecção B2B completa (9003) — decisores, custo e expurgo", () => {
  const EMPRESA_A = "90030000-3333-4000-8000-000000000001";
  const RODADA_A = "90030000-4444-4000-8000-000000000001";

  beforeEach(() => {
    sql(`
      delete from prospecting_provider_costs where organization_id in ('${ORG_A}', '${ORG_B}');
      delete from prospecting_b2b_suppressions where organization_id in ('${ORG_A}', '${ORG_B}');
      insert into prospecting_b2b_companies (id, organization_id, search_id, cnpj, razao_social, data)
        values ('${EMPRESA_A}', '${ORG_A}', '${NOVA}', '44444444000144', 'Com Decisor LTDA', '{}'::jsonb);
      insert into prospecting_b2b_enrichment_runs (id, organization_id, search_id, request_id, cargos, teto_micro)
        values ('${RODADA_A}', '${ORG_A}', '${NOVA}', gen_random_uuid(), array['CEO'], 1000000);
      insert into prospecting_b2b_enrichment_items (organization_id, run_id, company_id)
        values ('${ORG_A}', '${RODADA_A}', '${EMPRESA_A}');
      insert into prospecting_b2b_contacts (organization_id, company_id, run_id, nome, email, email_status, expires_at) values
        ('${ORG_A}', '${EMPRESA_A}', '${RODADA_A}', 'Ana Vencida', 'ana@x.com.br', 'valid', now() - interval '1 day'),
        ('${ORG_A}', '${EMPRESA_A}', '${RODADA_A}', 'Bia Valida', 'bia@x.com.br', 'valid', now() + interval '100 days');
    `);
  });

  it("o mesmo decisor não entra duas vezes na mesma empresa (sem diferença de caixa)", () => {
    expect(() =>
      sql(`insert into prospecting_b2b_contacts (organization_id, company_id, nome) values ('${ORG_A}', '${EMPRESA_A}', 'BIA VALIDA');`),
    ).toThrow();
  });

  it("o expurgo leva o decisor vencido e deixa o válido (o argumento de dias não muda a validade)", () => {
    expect(conta(`select public.fn_expurgar_contatos_b2b_vencidos(99999, 1000);`)).toBeGreaterThanOrEqual(1);
    expect(conta(`select count(*) from prospecting_b2b_contacts where company_id = '${EMPRESA_A}' and nome = 'Ana Vencida';`)).toBe(0);
    expect(conta(`select count(*) from prospecting_b2b_contacts where company_id = '${EMPRESA_A}' and nome = 'Bia Valida';`)).toBe(1);
  });

  it("apagar a busca leva rodadas, livro-caixa e decisores", () => {
    sql(`delete from prospecting_b2b_searches where id = '${NOVA}';`);
    expect(conta(`select count(*) from prospecting_b2b_enrichment_runs where id = '${RODADA_A}';`)).toBe(0);
    expect(conta(`select count(*) from prospecting_b2b_enrichment_items where run_id = '${RODADA_A}';`)).toBe(0);
    expect(conta(`select count(*) from prospecting_b2b_contacts where company_id = '${EMPRESA_A}';`)).toBe(0);
  });

  it("a supressão só aceita hash sha256 (nunca o e-mail em claro)", () => {
    expect(() =>
      sql(`insert into prospecting_b2b_suppressions (organization_id, chave_hash) values ('${ORG_A}', 'ana@x.com.br');`),
    ).toThrow();
    sql(`insert into prospecting_b2b_suppressions (organization_id, chave_hash) values ('${ORG_A}', repeat('a', 64));`);
  });

  it("o custo do Treg vira R$ pela PTAX do dia de cada consulta; B não entra na conta de A; o recibo não repete", () => {
    sql(`
      insert into cotacoes_do_dolar (data, venda) values ('2001-01-01', 5.0), ('2001-01-10', 6.0)
        on conflict (data) do update set venda = excluded.venda;
      insert into prospecting_provider_costs (organization_id, provider, operacao, unidades, custo_usd_micro, call_id, created_at) values
        ('${ORG_A}', 'treg', 'busca', 1, 1000000, 'call-1', '2001-01-05 12:00:00-03'),
        ('${ORG_A}', 'treg', 'email', 1, 1000000, 'call-2', '2001-01-12 12:00:00-03'),
        ('${ORG_B}', 'treg', 'busca', 1, 9000000, 'call-3', '2001-01-05 12:00:00-03');
      insert into prospecting_provider_costs (organization_id, provider, operacao, unidades, custo_brl_cents, created_at) values
        ('${ORG_A}', 'cnpja', 'busca', 5, 8, '2001-01-05 12:00:00-03');
    `);
    expect(() =>
      sql(`insert into prospecting_provider_costs (organization_id, provider, operacao, unidades, custo_usd_micro, call_id)
           values ('${ORG_A}', 'treg', 'busca', 1, 1, 'call-1');`),
    ).toThrow();
    const r = JSON.parse(
      lastLine(sql(`select public.fn_custo_dos_provedores('${ORG_A}', '2000-12-01', '2001-02-01');`)),
    ) as { provedores: Array<{ provider: string; custo_brl_cents: number; custo_usd_micro: number; unidades: number }>; total_brl_cents: number };
    const treg = r.provedores.find((p) => p.provider === "treg")!;
    const cnpja = r.provedores.find((p) => p.provider === "cnpja")!;
    // US$ 1 no dia 5 (PTAX 5,00) + US$ 1 no dia 12 (PTAX 6,00) = R$ 11,00.
    expect(Number(treg.custo_brl_cents)).toBe(1100);
    expect(Number(treg.custo_usd_micro)).toBe(2_000_000);
    expect(Number(cnpja.custo_brl_cents)).toBe(8);
    expect(Number(cnpja.unidades)).toBe(5);
    expect(Number(r.total_brl_cents)).toBe(1108);
  });
});
