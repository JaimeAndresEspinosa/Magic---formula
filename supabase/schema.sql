-- Magic Formula Screener — esquema de Supabase
-- Pegar entero en Supabase → SQL Editor → New query → Run.
-- Se puede ejecutar más de una vez sin romper nada.

-- ---------------------------------------------------------------------------
-- 1. Ranking diario (lo escribe el servidor; lo puede leer cualquiera)
-- ---------------------------------------------------------------------------
create table if not exists public.ranking_snapshots (
  date        date        not null,
  universe    text        not null,          -- sp500 | ndx | ibex | sx5e
  roc_method  text        not null,          -- tangible | gw
  min_cap     double precision not null,     -- capitalización mínima usada (USD)
  bench       jsonb,                         -- {"s": "^GSPC", "px": 7839.2}
  rows        jsonb       not null,          -- top 50: [{s, n, px, cur, ey, roc, mf}]
  created_at  timestamptz not null default now(),
  primary key (date, universe, roc_method)
);

alter table public.ranking_snapshots enable row level security;

drop policy if exists "ranking legible por todos" on public.ranking_snapshots;
create policy "ranking legible por todos"
  on public.ranking_snapshots for select
  to anon, authenticated
  using (true);
-- Sin políticas de escritura: solo el servidor (clave secreta) puede escribir.

-- ---------------------------------------------------------------------------
-- 2. Simulaciones de cada usuario (cada uno solo ve y toca las suyas)
-- ---------------------------------------------------------------------------
create table if not exists public.simulations (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  sim_id      text        not null,          -- id interno de la simulación en la web
  payload     jsonb       not null,          -- definición completa de la simulación
  created_at  timestamptz not null default now(),
  unique (user_id, sim_id)
);

create index if not exists simulations_user_idx on public.simulations (user_id);

alter table public.simulations enable row level security;

drop policy if exists "ver mis simulaciones" on public.simulations;
create policy "ver mis simulaciones"
  on public.simulations for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "crear mis simulaciones" on public.simulations;
create policy "crear mis simulaciones"
  on public.simulations for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "editar mis simulaciones" on public.simulations;
create policy "editar mis simulaciones"
  on public.simulations for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "borrar mis simulaciones" on public.simulations;
create policy "borrar mis simulaciones"
  on public.simulations for delete
  to authenticated
  using ((select auth.uid()) = user_id);
