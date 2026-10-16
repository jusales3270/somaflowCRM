-- manifest: prospecção B2B completa — decisores pelo Treg (rodadas com teto de gasto, livro-caixa por empresa, contatos com validade de 180 dias e supressão), nota de aderência do Jev por empresa e livro de custo dos provedores externos (CNPJá em créditos, Treg em US$) lido por fn_custo_dos_provedores para Uso e orçamento.
--
-- 9001+ é o bloco de migrations do fork (não colide com o upstream).
--
-- 1. prospecting_b2b_enrichment_runs — uma rodada de "achar decisores" sobre as
--    empresas MARCADAS de uma busca: cargos-alvo, teto de gasto (micro-US$),
--    gasto até aqui. Para sozinha no teto (`stopped_budget`) ou sem saldo
--    (`no_balance`) — o que já foi achado fica.
-- 2. prospecting_b2b_enrichment_items — o livro-caixa da rodada, UMA linha por
--    empresa: quem processa toma a linha por lease (`for update skip locked`),
--    e a retentativa usa a mesma chave de idempotência no Treg — nunca paga
--    duas vezes pela mesma empresa.
-- 3. prospecting_b2b_contacts — o decisor achado (pessoa física): nome, cargo,
--    LinkedIn, e-mail com o veredicto da verificação, celular. Base legal
--    registrada (legítimo interesse, B2B) e validade de 180 dias, expurgada por
--    fn_expurgar_contatos_b2b_vencidos no cron data-retention.
-- 4. prospecting_b2b_suppressions — "remover e não buscar de novo": o hash
--    (sha256) do e-mail / LinkedIn / nome+CNPJ de quem pediu para sair. A rodada
--    seguinte pula quem casa com um hash daqui.
-- 5. prospecting_provider_costs — o livro de custo dos provedores EXTERNOS da
--    prospecção (CNPJá, Treg). Fica FORA de llm_calls de propósito: lá ele
--    entraria no teto mensal de IA e um gasto de prospecção pararia as respostas
--    da IA no WhatsApp. `call_id` único por org+provedor: o mesmo recibo não
--    entra duas vezes.
-- 6. prospecting_b2b_companies ganha a confiança e a data da nota do Jev;
--    prospecting_provider_credentials ganha o preço da unidade em R$ (o crédito
--    da CNPJá depende do plano de quem assina).
-- 7. fn_custo_dos_provedores — o que a tela Uso e orçamento mostra: por provedor,
--    unidades, US$ e R$ (Treg convertido pela PTAX do DIA de cada chamada, como
--    fn_custo_das_ligacoes/9001). security definer, só service_role: as tabelas
--    da prospecção B2B não têm política para `authenticated`.
--
-- RLS ligada e sem política nas tabelas novas: só a service role alcança, como
-- 9002. Idempotente.

create table if not exists public.prospecting_b2b_enrichment_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  search_id uuid not null references public.prospecting_b2b_searches(id) on delete cascade,
  request_id uuid not null,
  cargos text[] not null check (cardinality(cargos) between 1 and 5),
  por_empresa smallint not null default 1 check (por_empresa between 1 and 3),
  com_celular boolean not null default false,
  teto_micro bigint not null check (teto_micro > 0),
  gasto_micro bigint not null default 0 check (gasto_micro >= 0),
  status text not null default 'running'
    check (status in ('running', 'done', 'stopped_budget', 'no_balance', 'failed', 'cancelled')),
  empresas_total integer not null default 0,
  empresas_feitas integer not null default 0,
  contatos_achados integer not null default 0,
  error text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, request_id)
);

create index if not exists prospecting_b2b_enrichment_runs_org_idx
  on public.prospecting_b2b_enrichment_runs (organization_id, search_id, created_at desc);
create index if not exists prospecting_b2b_enrichment_runs_ativas_idx
  on public.prospecting_b2b_enrichment_runs (status) where status = 'running';

create table if not exists public.prospecting_b2b_enrichment_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null references public.prospecting_b2b_enrichment_runs(id) on delete cascade,
  company_id uuid not null references public.prospecting_b2b_companies(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'done', 'miss', 'failed', 'skipped')),
  tentativas smallint not null default 0,
  lease_until timestamptz,
  custo_micro bigint not null default 0 check (custo_micro >= 0),
  contatos integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, company_id)
);

create index if not exists prospecting_b2b_enrichment_items_fila_idx
  on public.prospecting_b2b_enrichment_items (run_id, status);

create table if not exists public.prospecting_b2b_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null references public.prospecting_b2b_companies(id) on delete cascade,
  run_id uuid references public.prospecting_b2b_enrichment_runs(id) on delete set null,
  nome text not null,
  cargo text,
  linkedin_url text,
  email text,
  email_status text check (email_status is null or email_status in ('valid', 'invalid', 'catch_all', 'risky', 'unknown')),
  telefone text,
  telefone_tipo text,
  fonte text,
  custo_micro bigint not null default 0 check (custo_micro >= 0),
  base_legal text not null default 'legitimo_interesse_b2b',
  expires_at timestamptz not null default (now() + interval '180 days'),
  created_at timestamptz not null default now()
);

create unique index if not exists prospecting_b2b_contacts_pessoa_uidx
  on public.prospecting_b2b_contacts (company_id, lower(nome));
create index if not exists prospecting_b2b_contacts_org_idx
  on public.prospecting_b2b_contacts (organization_id, company_id);
create index if not exists prospecting_b2b_contacts_validade_idx
  on public.prospecting_b2b_contacts (expires_at);

create table if not exists public.prospecting_b2b_suppressions (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chave_hash text not null check (chave_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (organization_id, chave_hash)
);

create table if not exists public.prospecting_provider_costs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('cnpja', 'treg')),
  operacao text not null,
  unidades numeric not null default 0 check (unidades >= 0),
  custo_usd_micro bigint check (custo_usd_micro is null or custo_usd_micro >= 0),
  custo_brl_cents numeric check (custo_brl_cents is null or custo_brl_cents >= 0),
  referencia_id uuid,
  call_id text,
  created_at timestamptz not null default now()
);

create index if not exists prospecting_provider_costs_org_idx
  on public.prospecting_provider_costs (organization_id, created_at desc);
create unique index if not exists prospecting_provider_costs_recibo_uidx
  on public.prospecting_provider_costs (organization_id, provider, call_id) where call_id is not null;

alter table public.prospecting_b2b_companies add column if not exists score_confianca numeric;
alter table public.prospecting_b2b_companies add column if not exists scored_at timestamptz;
alter table public.prospecting_provider_credentials add column if not exists preco_unidade_brl numeric
  check (preco_unidade_brl is null or preco_unidade_brl >= 0);

alter table public.prospecting_b2b_enrichment_runs enable row level security;
alter table public.prospecting_b2b_enrichment_items enable row level security;
alter table public.prospecting_b2b_contacts enable row level security;
alter table public.prospecting_b2b_suppressions enable row level security;
alter table public.prospecting_provider_costs enable row level security;

-- O default ACL do Supabase dá tudo a anon/authenticated em tabela nova de public.
revoke all on table public.prospecting_b2b_enrichment_runs from public, anon, authenticated;
revoke all on table public.prospecting_b2b_enrichment_items from public, anon, authenticated;
revoke all on table public.prospecting_b2b_contacts from public, anon, authenticated;
revoke all on table public.prospecting_b2b_suppressions from public, anon, authenticated;
revoke all on table public.prospecting_provider_costs from public, anon, authenticated;
grant all on table public.prospecting_b2b_enrichment_runs to service_role;
grant all on table public.prospecting_b2b_enrichment_items to service_role;
grant all on table public.prospecting_b2b_contacts to service_role;
grant all on table public.prospecting_b2b_suppressions to service_role;
grant all on table public.prospecting_provider_costs to service_role;

create or replace function public.fn_custo_dos_provedores(
  p_org uuid,
  p_desde timestamptz,
  p_ate timestamptz
) returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with linhas as (
    select c.provider, c.operacao, c.unidades, c.custo_usd_micro, c.custo_brl_cents,
           (c.created_at at time zone 'America/Sao_Paulo')::date as dia
      from public.prospecting_provider_costs c
     where c.organization_id = p_org
       and c.created_at >= p_desde
       and c.created_at < p_ate
  ),
  convertidas as (
    select l.provider, l.operacao, l.unidades, l.custo_usd_micro,
           coalesce(
             l.custo_brl_cents,
             case when l.custo_usd_micro is not null and cot.venda is not null
                  then l.custo_usd_micro::numeric / 10000 * cot.venda end
           ) as brl_cents,
           (l.custo_brl_cents is null and l.custo_usd_micro is not null and cot.venda is null) as sem_cotacao
      from linhas l
      left join lateral (
        select d.venda from public.cotacoes_do_dolar d
         order by (d.data > l.dia), case when d.data <= l.dia then d.data end desc, d.data asc
         limit 1
      ) cot on true
  ),
  por_provedor as (
    select provider,
           count(*) as chamadas,
           coalesce(sum(unidades), 0) as unidades,
           coalesce(sum(custo_usd_micro), 0) as custo_usd_micro,
           round(coalesce(sum(brl_cents), 0), 2) as custo_brl_cents,
           count(*) filter (where sem_cotacao) as sem_cotacao,
           jsonb_object_agg(operacao, n) as operacoes
      from (
        select c.*, count(*) over (partition by provider, operacao) as n from convertidas c
      ) x
     group by provider
  )
  select jsonb_build_object(
    'provedores', coalesce((select jsonb_agg(to_jsonb(p) order by p.provider) from por_provedor p), '[]'::jsonb),
    'total_brl_cents', coalesce((select round(sum(brl_cents), 2) from convertidas), 0),
    'cotacao_atual', (select jsonb_build_object('data', d.data, 'venda', d.venda)
                        from public.cotacoes_do_dolar d order by d.data desc limit 1)
  );
$$;

comment on function public.fn_custo_dos_provedores(uuid, timestamptz, timestamptz) is
  'Custo dos provedores externos da prospecção B2B (CNPJá, Treg) no período, em unidades, US$ e R$ (PTAX do dia). Informativo: não é a régua do teto de IA.';

revoke all     on function public.fn_custo_dos_provedores(uuid, timestamptz, timestamptz) from public;
revoke execute on function public.fn_custo_dos_provedores(uuid, timestamptz, timestamptz) from anon;
revoke execute on function public.fn_custo_dos_provedores(uuid, timestamptz, timestamptz) from authenticated;
grant  execute on function public.fn_custo_dos_provedores(uuid, timestamptz, timestamptz) to service_role;

-- A assinatura (p_retencao_dias, p_limite) é a das outras podas, para o dreno do
-- cron data-retention chamar todas igual. O prazo NÃO vem do argumento: é a
-- validade gravada em cada linha (`expires_at`, 180 dias a partir de quando o
-- decisor foi achado) — o primeiro argumento é ignorado de propósito.
create or replace function public.fn_expurgar_contatos_b2b_vencidos(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagados int;
begin
  -- Sem seletor de linha: o único predicado é a validade gravada na linha
  -- (180 dias a partir de quando o decisor foi achado).
  with vencidos as (
    select c.id from public.prospecting_b2b_contacts c
     where c.expires_at < now()
     order by c.expires_at
     limit v_limite
  )
  delete from public.prospecting_b2b_contacts c using vencidos v where c.id = v.id;
  get diagnostics v_apagados = row_count;
  return v_apagados;
end;
$$;

revoke all     on function public.fn_expurgar_contatos_b2b_vencidos(int, int) from public;
revoke execute on function public.fn_expurgar_contatos_b2b_vencidos(int, int) from anon;
revoke execute on function public.fn_expurgar_contatos_b2b_vencidos(int, int) from authenticated;
grant  execute on function public.fn_expurgar_contatos_b2b_vencidos(int, int) to service_role;

notify pgrst, 'reload schema';
