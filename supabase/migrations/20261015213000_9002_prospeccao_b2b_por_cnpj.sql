-- manifest: prospecção B2B por CNPJ — chaves por provedor (CNPJá, Treg), buscas e empresas encontradas por CNAE/UF/município/porte, com expurgo pelo mesmo prazo da prospecção; o motor Google Maps (prospecting_campaigns/candidates) não muda.
--
-- 9001+ é o bloco de migrations do fork (não colide com o upstream).
--
-- POR QUE TABELAS NOVAS, E NÃO UM `kind` EM prospecting_candidates: aquela tabela
-- é a FILA de WhatsApp (status, attempted_at, telefone único, worker, seleção na
-- fila, redação de LGPD que reescreve `data` no formato do Google Maps). A lista
-- B2B só é listada e exportada; morar em tabela própria faz "empresa B2B nunca
-- entra na fila de envio" ser verdade por construção, não por um filtro que
-- alguém um dia esquece.
--
-- 1. prospecting_provider_credentials — a chave de cada provedor da prospecção,
--    por organização. Cifrada por fn_encrypt_oauth, como prospecting_settings e
--    map_provider_credentials (0504). A chave do Apify continua onde sempre esteve
--    (prospecting_settings): o motor do Google Maps não é tocado.
-- 2. prospecting_b2b_searches — uma busca: filtros, token da próxima página,
--    créditos usados.
-- 3. prospecting_b2b_companies — as empresas da busca (dado de PESSOA JURÍDICA da
--    Receita). Minimização: o e-mail pessoal e o da contabilidade não entram
--    (lib/prospecting/b2b/cnpja.ts).
-- 4. fn_expurgar_prospeccao_b2b_vencida — apaga busca (e, em cascata, as
--    empresas) mais velha que o prazo da prospecção (PROSPECCAO_RETENTION_DAYS,
--    365 dias, piso de 90 no corpo), chamada pelo cron data-retention.
--
-- RLS ligada e sem política: só a service role alcança, como 0369. Idempotente.

create table if not exists public.prospecting_provider_credentials (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('cnpja', 'treg')),
  credential_encrypted bytea not null,
  last4 text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, provider)
);

create table if not exists public.prospecting_b2b_searches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  request_id uuid not null,
  name text not null,
  filtros jsonb not null,
  status text not null default 'running' check (status in ('running', 'done', 'partial', 'failed')),
  next_token text,
  credits_used integer not null default 0 check (credits_used >= 0),
  results_count integer not null default 0 check (results_count >= 0),
  total_available integer,
  error text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, request_id)
);

create index if not exists prospecting_b2b_searches_org_idx
  on public.prospecting_b2b_searches (organization_id, created_at desc);

create table if not exists public.prospecting_b2b_companies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  search_id uuid not null references public.prospecting_b2b_searches(id) on delete cascade,
  cnpj text not null check (cnpj ~ '^[0-9]{14}$'),
  razao_social text not null,
  uf text,
  municipio_ibge integer,
  porte_id smallint,
  capital_social numeric,
  data jsonb not null,
  selected boolean not null default true,
  score numeric,
  score_band text check (score_band is null or score_band in ('alta', 'media', 'baixa')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (search_id, cnpj)
);

create index if not exists prospecting_b2b_companies_search_idx
  on public.prospecting_b2b_companies (organization_id, search_id);

alter table public.prospecting_provider_credentials enable row level security;
alter table public.prospecting_b2b_searches enable row level security;
alter table public.prospecting_b2b_companies enable row level security;

-- O default ACL do Supabase dá tudo a anon/authenticated em tabela nova de public.
revoke all on table public.prospecting_provider_credentials from public, anon, authenticated;
revoke all on table public.prospecting_b2b_searches from public, anon, authenticated;
revoke all on table public.prospecting_b2b_companies from public, anon, authenticated;
grant all on table public.prospecting_provider_credentials to service_role;
grant all on table public.prospecting_b2b_searches to service_role;
grant all on table public.prospecting_b2b_companies to service_role;

create or replace function public.fn_expurgar_prospeccao_b2b_vencida(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Mesmo horizonte da prospecção (0408): 365 dias, piso de 90 AQUI no corpo,
  -- para valer contra qualquer chamador.
  v_dias int := greatest(coalesce(p_retencao_dias, 365), 90);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  with vencidas as (
    select s.id from public.prospecting_b2b_searches s
     where s.created_at < now() - make_interval(days => v_dias)
     order by s.created_at
     limit v_limite
  )
  delete from public.prospecting_b2b_searches s using vencidas v where s.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;

revoke all     on function public.fn_expurgar_prospeccao_b2b_vencida(int, int) from public;
revoke execute on function public.fn_expurgar_prospeccao_b2b_vencida(int, int) from anon;
revoke execute on function public.fn_expurgar_prospeccao_b2b_vencida(int, int) from authenticated;
grant  execute on function public.fn_expurgar_prospeccao_b2b_vencida(int, int) to service_role;

notify pgrst, 'reload schema';
