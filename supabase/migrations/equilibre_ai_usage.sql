-- Application Équilibre : journal des analyses de photos par IA.
-- Sert au plafond quotidien et au suivi du coût affiché dans l'app.
create table public.equilibre_ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(10, 5) not null default 0
);

comment on table public.equilibre_ai_usage is 'Application Équilibre : une ligne par analyse de photo (tokens et coût estimé).';

create index equilibre_ai_usage_user_created on public.equilibre_ai_usage (user_id, created_at desc);
create index equilibre_ai_usage_created on public.equilibre_ai_usage (created_at desc);

alter table public.equilibre_ai_usage enable row level security;

-- Lecture de ses propres lignes uniquement ; l'écriture est réservée à la
-- fonction serveur (clé de service), il n'y a donc aucune règle d'insertion.
revoke all on public.equilibre_ai_usage from anon, public, authenticated;
grant select on public.equilibre_ai_usage to authenticated;

create policy equilibre_ai_usage_read_own on public.equilibre_ai_usage
  for select to authenticated
  using ((select auth.uid()) = user_id);
