-- manifest: cotação do dólar (PTAX do Banco Central) por dia em cotacoes_do_dolar, e fn_custo_das_ligacoes, que soma no banco o custo das ligações de voz em US$ e em R$ — cada ligação convertida pela PTAX do dia em que aconteceu.
--
-- NUMERAÇÃO: 9001 em diante são as migrations DESTE FORK (SomaFlow). O upstream
-- numera a partir de 0001 e cresce de um em um; um bloco separado faz a
-- sincronização com ele nunca colidir em NNNN. O timestamp segue a ordem real.
--
-- O gasto de IA é medido em centavos de DÓLAR (llm_calls.cost_cents). A ligação
-- de voz passou a ter custo (tarifa da OpenAI Realtime em
-- workers/voice-agent/tarifa-realtime.ts), e quem paga em reais quer ver reais.
--
-- 1. cotacoes_do_dolar — global, como ai_pricing: a cotação é da instalação,
--    não de uma organização. Quem grava é o cron api/v1/cron/cotacao-do-dolar
--    (service role); quem está logado só lê. Sem linha nenhuma, a tela mostra o
--    dólar e diz que a cotação ainda não foi obtida — nunca converte por zero.
--
-- 2. fn_custo_das_ligacoes — security invoker (a RLS de llm_calls isola a
--    organização; p_org é defesa em profundidade), agregada NO BANCO para não
--    passar pelo max_rows do PostgREST. A cotação de cada ligação é a do dia
--    dela no calendário de Brasília; dia sem cotação (fim de semana, feriado,
--    antes da publicação das 13h) usa a última anterior; ligação mais antiga que
--    toda cotação guardada usa a primeira. Janela por argumento, nunca o mês:
--    não é a régua do teto (fn_gasto_de_ia_do_mes).
--
-- Idempotente: if not exists / create or replace / drop policy if exists.

create table if not exists public.cotacoes_do_dolar (
  data date primary key,
  venda numeric(12,6) not null check (venda > 0),
  compra numeric(12,6) check (compra is null or compra > 0),
  fonte text not null default 'bcb_ptax',
  obtida_em timestamptz not null default now()
);

comment on table public.cotacoes_do_dolar is
  'PTAX do Banco Central por dia (reais por dólar). Global, não tenant-aware: a cotação é da instalação. Gravada pelo cron api/v1/cron/cotacao-do-dolar; lida por fn_custo_das_ligacoes para converter em reais o custo das ligações de voz.';

alter table public.cotacoes_do_dolar enable row level security;

drop policy if exists cotacoes_do_dolar_leitura on public.cotacoes_do_dolar;
create policy cotacoes_do_dolar_leitura on public.cotacoes_do_dolar
  for select to authenticated using (true);

-- O default ACL do Supabase dá tudo a anon e authenticated em tabela nova de
-- public: revogar explicitamente é o que protege (ver CLAUDE.md, audit log).
revoke all on table public.cotacoes_do_dolar from public, anon, authenticated;
grant select on table public.cotacoes_do_dolar to authenticated;

create or replace function public.fn_custo_das_ligacoes(
  p_org uuid,
  p_desde timestamptz,
  p_ate timestamptz,
  p_recentes integer default 20
)
returns jsonb
  language sql
  stable
  security invoker
  set search_path to 'public', 'pg_temp'
as $$
  with ligacoes as (
    select c.created_at,
           c.model,
           c.status,
           c.cost_cents,
           c.latency_ms,
           (c.created_at at time zone 'America/Sao_Paulo')::date as dia
      from public.llm_calls c
     where c.organization_id = p_org
       and c.purpose = 'voz_ao_vivo'
       and c.created_at >= p_desde
       and c.created_at <= p_ate
  ),
  convertidas as (
    select l.*,
           cot.data as cotacao_data,
           cot.venda as cotacao,
           l.cost_cents * cot.venda as custo_brl_cents
      from ligacoes l
      left join lateral (
        select d.data, d.venda
          from public.cotacoes_do_dolar d
         order by (d.data > l.dia),
                  case when d.data <= l.dia then d.data end desc,
                  d.data asc
         limit 1
      ) cot on true
  )
  select jsonb_build_object(
    'totais', (
      select jsonb_build_object(
        'ligacoes', count(*) filter (where status = 'ok'),
        'falhas', count(*) filter (where status = 'erro'),
        'duracao_ms', coalesce(sum(latency_ms) filter (where status = 'ok'), 0),
        'custo_usd_cents', coalesce(sum(cost_cents), 0),
        'custo_brl_cents', coalesce(sum(custo_brl_cents), 0),
        'sem_preco', count(*) filter (where status = 'ok' and cost_cents is null),
        'sem_cotacao', count(*) filter (where cost_cents is not null and cotacao is null)
      )
      from convertidas
    ),
    'recentes', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at desc)
        from (
          select created_at, model, status, latency_ms as duracao_ms,
                 cost_cents as custo_usd_cents, custo_brl_cents, cotacao, cotacao_data
            from convertidas
           order by created_at desc
           limit greatest(0, least(coalesce(p_recentes, 20), 100))
        ) r
    ), '[]'::jsonb),
    'cotacao_atual', (
      select jsonb_build_object('data', d.data, 'venda', d.venda)
        from public.cotacoes_do_dolar d
       order by d.data desc
       limit 1
    )
  );
$$;

comment on function public.fn_custo_das_ligacoes(uuid, timestamptz, timestamptz, integer) is
  'Custo das ligações de voz (llm_calls purpose voz_ao_vivo) da organização num período, em centavos de dólar e de real — cada ligação convertida pela PTAX (cotacoes_do_dolar) do dia dela em Brasília, ou a última anterior. Totais, as ligações mais recentes e a cotação mais nova. jsonb para não passar pelo max_rows do PostgREST. security invoker: a RLS isola; p_org é defesa em profundidade. Não é a régua do teto mensal (fn_gasto_de_ia_do_mes).';

revoke execute on function public.fn_custo_das_ligacoes(uuid, timestamptz, timestamptz, integer)
  from public, anon;
grant  execute on function public.fn_custo_das_ligacoes(uuid, timestamptz, timestamptz, integer)
  to authenticated, service_role;

notify pgrst, 'reload schema';
