-- ============================================================================
-- Closer Pro — schéma Supabase
-- À exécuter une fois dans : Supabase Dashboard → SQL Editor → New query → Run
-- ============================================================================

-- Un document par closer : l'état complet de l'app (prospects, écosystèmes,
-- offres, objectif, notes) tel qu'il vit aujourd'hui dans le localStorage.
create table if not exists public.closer_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- Row Level Security
-- INDISPENSABLE : la clé anon est publique. Sans ces règles, n'importe qui
-- pourrait lire et écrire toute la table depuis la console du navigateur.
-- ============================================================================
alter table public.closer_state enable row level security;

-- Chaque closer ne voit que sa propre ligne.
drop policy if exists "closer lit ses donnees" on public.closer_state;
create policy "closer lit ses donnees"
  on public.closer_state for select
  using (auth.uid() = user_id);

-- Chaque closer ne peut créer qu'une ligne à son propre nom.
drop policy if exists "closer cree ses donnees" on public.closer_state;
create policy "closer cree ses donnees"
  on public.closer_state for insert
  with check (auth.uid() = user_id);

-- Chaque closer ne peut modifier que sa propre ligne, et ne peut pas
-- la réattribuer à quelqu'un d'autre (d'où le `with check`).
drop policy if exists "closer modifie ses donnees" on public.closer_state;
create policy "closer modifie ses donnees"
  on public.closer_state for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Volontairement aucune policy DELETE : les données d'un closer ne peuvent pas
-- être supprimées depuis l'app. La ligne part avec le compte (on delete cascade).

-- ============================================================================
-- Horodatage automatique — sert aussi à détecter les conflits multi-appareils.
-- ============================================================================
create or replace function public.touch_closer_state()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists closer_state_touch on public.closer_state;
create trigger closer_state_touch
  before update on public.closer_state
  for each row execute function public.touch_closer_state();

-- ============================================================================
-- Vérification : doit renvoyer rowsecurity = true
-- ============================================================================
-- select tablename, rowsecurity from pg_tables where tablename = 'closer_state';
