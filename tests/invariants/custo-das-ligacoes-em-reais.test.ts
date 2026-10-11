/**
 * O CUSTO DAS LIGAÇÕES EM REAIS (migration 9001) — num Postgres real com o
 * baseline aplicado.
 *
 *   1. Cada ligação é convertida pela PTAX do DIA DELA em Brasília: dia sem
 *      cotação usa a última anterior; ligação mais velha que toda cotação usa a
 *      primeira; 23h de Brasília é o dia de Brasília, não o de UTC.
 *   2. Só `voz_ao_vivo` entra; falha de handshake conta à parte; custo NULO
 *      (modelo sem tarifa) é contado como `sem_preco`, nunca como zero em reais.
 *   3. Isolamento: `security invoker` — a pessoa de A que pede B recebe zero, e
 *      o controle como dono mostra que B tem ligação.
 *   4. `anon` não executa nem lê cotação; `authenticated` lê mas não grava.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USUARIO_A = randomUUID();
const DESDE = "2026-07-25T00:00:00.000Z";
const ATE = "2026-08-31T23:59:59.999Z";
const ASSINATURA = "public.fn_custo_das_ligacoes(uuid, timestamptz, timestamptz, integer)";

interface Custo {
  totais: {
    ligacoes: number;
    falhas: number;
    duracao_ms: number;
    custo_usd_cents: number;
    custo_brl_cents: number;
    sem_preco: number;
    sem_cotacao: number;
  };
  recentes: Array<{
    created_at: string;
    status: string;
    custo_usd_cents: number | null;
    custo_brl_cents: number | null;
    cotacao: number | null;
    cotacao_data: string | null;
  }>;
  cotacao_atual: { data: string; venda: number } | null;
}

function ultimaLinha(saida: string): string {
  return saida.split("\n").filter(Boolean).at(-1) ?? "";
}

function comoA(consulta: string): string {
  return sql(
    `set role authenticated; select set_config('request.jwt.claims', '{"sub":"${USUARIO_A}","role":"authenticated"}', false);\n${consulta}`,
  );
}

function custoComo(papel: "authenticated" | "dono", org: string): Custo {
  const chamada = `select public.fn_custo_das_ligacoes('${org}', '${DESDE}', '${ATE}', 20)::text;`;
  return JSON.parse(ultimaLinha(papel === "authenticated" ? comoA(chamada) : sql(chamada))) as Custo;
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${USUARIO_A}', 'custo-voz-${USUARIO_A}@invariant.test');
    insert into organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'custo-voz-a-${ORG_A}', 'Voz A', 'Voz A'),
      ('${ORG_B}', 'custo-voz-b-${ORG_B}', 'Voz B', 'Voz B');
    insert into user_organizations (user_id, organization_id, role, accepted_at)
      values ('${USUARIO_A}', '${ORG_A}', 'manager', now());

    -- Segunda 5,00; terça 4,80; quarta SEM cotação; quinta 5,20.
    insert into cotacoes_do_dolar (data, venda, compra) values
      ('2026-08-03', 5.00, 4.99), ('2026-08-04', 4.80, 4.79), ('2026-08-06', 5.20, 5.19)
    on conflict (data) do update set venda = excluded.venda;

    insert into llm_calls (organization_id, purpose, provider, model, cost_cents, latency_ms, status, created_at) values
      -- terça 12h de Brasília: 100 × 4,80 = 480
      ('${ORG_A}', 'voz_ao_vivo', 'openai', 'gpt-realtime', 100, 60000, 'ok', '2026-08-04T15:00:00Z'),
      -- quarta (sem cotação) → a de terça: 50 × 4,80 = 240
      ('${ORG_A}', 'voz_ao_vivo', 'openai', 'gpt-realtime', 50, 30000, 'ok', '2026-08-05T15:00:00Z'),
      -- 02h UTC de quarta = 23h de TERÇA em Brasília → 4,80: 10 × 4,80 = 48
      ('${ORG_A}', 'voz_ao_vivo', 'openai', 'gpt-realtime', 10, 6000, 'ok', '2026-08-05T02:00:00Z'),
      -- antes de toda cotação guardada → a primeira (5,00): 20 × 5,00 = 100
      ('${ORG_A}', 'voz_ao_vivo', 'openai', 'gpt-realtime', 20, 12000, 'ok', '2026-08-01T15:00:00Z'),
      -- modelo sem tarifa: sem preço, fora do total em reais
      ('${ORG_A}', 'voz_ao_vivo', 'openai', 'gpt-realtime-futuro', null, 9000, 'ok', '2026-08-06T15:00:00Z'),
      -- handshake recusado
      ('${ORG_A}', 'voz_ao_vivo', 'openai', 'gpt-realtime', 0, 300, 'erro', '2026-08-06T16:00:00Z'),
      -- outra finalidade da mesma organização: não é ligação
      ('${ORG_A}', 'agent_turn', 'anthropic', 'claude-x', 999, 1500, 'ok', '2026-08-04T15:00:00Z'),
      -- B tem ligação no mesmo período: o zero que A recebe tem de ser isolamento
      ('${ORG_B}', 'voz_ao_vivo', 'openai', 'gpt-realtime', 777, 60000, 'ok', '2026-08-04T15:00:00Z');
  `);
});

afterAll(() => {
  sql(`
    delete from organizations where id in ('${ORG_A}', '${ORG_B}');
    delete from auth.users where id = '${USUARIO_A}';
    delete from cotacoes_do_dolar where data in ('2026-08-03', '2026-08-04', '2026-08-06');
  `);
});

describe("fn_custo_das_ligacoes converte cada ligação pela PTAX do dia dela", () => {
  it("totais em dólar e em reais", () => {
    const { totais } = custoComo("authenticated", ORG_A);
    expect(totais.ligacoes).toBe(5);
    expect(totais.falhas).toBe(1);
    expect(totais.duracao_ms).toBe(60000 + 30000 + 6000 + 12000 + 9000);
    expect(totais.custo_usd_cents).toBe(180);
    expect(totais.custo_brl_cents).toBeCloseTo(480 + 240 + 48 + 100, 6);
    expect(totais.sem_preco).toBe(1);
    expect(totais.sem_cotacao).toBe(0);
  });

  it("a cotação de cada ligação: o dia dela, a anterior, ou a primeira", () => {
    const { recentes } = custoComo("authenticated", ORG_A);
    const porMomento = new Map(recentes.map((r) => [new Date(r.created_at).toISOString(), r]));
    expect(porMomento.get("2026-08-04T15:00:00.000Z")?.cotacao_data).toBe("2026-08-04");
    expect(porMomento.get("2026-08-05T15:00:00.000Z")?.cotacao_data).toBe("2026-08-04");
    expect(porMomento.get("2026-08-05T02:00:00.000Z")?.cotacao_data).toBe("2026-08-04");
    expect(porMomento.get("2026-08-01T15:00:00.000Z")?.cotacao_data).toBe("2026-08-03");
    expect(porMomento.get("2026-08-06T15:00:00.000Z")?.custo_brl_cents).toBeNull();
  });

  it("as recentes vêm da mais nova para a mais velha, e a cotação atual é a mais nova", () => {
    const custo = custoComo("authenticated", ORG_A);
    const momentos = custo.recentes.map((r) => new Date(r.created_at).getTime());
    expect(momentos).toEqual([...momentos].sort((a, b) => b - a));
    expect(custo.recentes).toHaveLength(6);
    expect(custo.cotacao_atual).toEqual({ data: "2026-08-06", venda: 5.2 });
  });

  it("isolamento: A pedindo B recebe zero — e B tem ligação (controle como dono)", () => {
    expect(custoComo("dono", ORG_B).totais.custo_usd_cents).toBe(777);
    const deB = custoComo("authenticated", ORG_B);
    expect(deB.totais.ligacoes).toBe(0);
    expect(deB.totais.custo_usd_cents).toBe(0);
    expect(deB.recentes).toEqual([]);
  });
});

describe("privilégios", () => {
  it("anon não executa a função nem lê a cotação; authenticated executa", () => {
    const [anonExec, autenticadoExec, anonLe] = ultimaLinha(
      sql(`select has_function_privilege('anon', '${ASSINATURA}', 'execute'),
                  has_function_privilege('authenticated', '${ASSINATURA}', 'execute'),
                  has_table_privilege('anon', 'public.cotacoes_do_dolar', 'select');`),
    ).split("|");
    expect(anonExec).toBe("f");
    expect(autenticadoExec).toBe("t");
    expect(anonLe).toBe("f");
  });

  it("authenticated lê a cotação mas não grava, não altera e não apaga", () => {
    const [le, insere, altera, apaga] = ultimaLinha(
      sql(`select has_table_privilege('authenticated', 'public.cotacoes_do_dolar', 'select'),
                  has_table_privilege('authenticated', 'public.cotacoes_do_dolar', 'insert'),
                  has_table_privilege('authenticated', 'public.cotacoes_do_dolar', 'update'),
                  has_table_privilege('authenticated', 'public.cotacoes_do_dolar', 'delete');`),
    ).split("|");
    expect([le, insere, altera, apaga]).toEqual(["t", "f", "f", "f"]);
  });
});
