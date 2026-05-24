-- FM RUN Ranking-System: Schema, RLS, RPC
-- Anwendbar via Supabase Dashboard (SQL Editor) oder MCP apply_migration.

-- ---------- 1. Tabelle profiles ----------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  handle        text not null,
  best_distance integer not null default 0 check (best_distance >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint handle_format check (handle ~ '^[A-Za-z0-9_]{3,20}$')
);

-- Handle case-insensitiv eindeutig
create unique index if not exists profiles_handle_lower_idx
  on public.profiles (lower(handle));

-- ---------- 2. Tabelle friendships ----------
create table if not exists public.friendships (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending','accepted')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint no_self_friend check (requester_id <> addressee_id)
);

-- Verhindert doppelte Beziehung in beide Richtungen (A->B und B->A)
create unique index if not exists friendships_pair_idx
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

-- ---------- 3. updated_at Trigger ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists friendships_touch on public.friendships;
create trigger friendships_touch before update on public.friendships
  for each row execute function public.touch_updated_at();

-- ---------- 4. RLS ----------
alter table public.profiles    enable row level security;
alter table public.friendships enable row level security;

-- profiles: öffentliche Leseliste (nur handle + best_distance), Schreiben nur eigene Zeile
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (true);

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert with check (id = auth.uid());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- friendships: nur eigene Beziehungen sichtbar; senden als requester; annehmen nur addressee
drop policy if exists friendships_select on public.friendships;
create policy friendships_select on public.friendships
  for select using (auth.uid() = requester_id or auth.uid() = addressee_id);

drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships
  for insert with check (auth.uid() = requester_id and status = 'pending');

drop policy if exists friendships_update on public.friendships;
create policy friendships_update on public.friendships
  for update using (auth.uid() = addressee_id) with check (status = 'accepted');

drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete on public.friendships
  for delete using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- ---------- 5. RPC-Funktionen ----------
-- Einziger Schreibpfad für den Score; erzwingt monoton steigenden Rekord.
create or replace function public.submit_score(p_distance integer)
returns integer language sql security invoker as $$
  update public.profiles
     set best_distance = greatest(best_distance, p_distance)
   where id = auth.uid()
  returning best_distance;
$$;

-- Ich + akzeptierte Freunde, sortiert nach Distanz absteigend.
create or replace function public.friends_leaderboard()
returns table(handle text, best_distance integer, is_me boolean)
language sql security invoker stable as $$
  select p.handle, p.best_distance, (p.id = auth.uid()) as is_me
    from public.profiles p
   where p.id = auth.uid()
      or p.id in (
        select case when f.requester_id = auth.uid() then f.addressee_id
                    else f.requester_id end
          from public.friendships f
         where f.status = 'accepted'
           and (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
      )
   order by p.best_distance desc, p.handle asc;
$$;

-- 1 + Anzahl Profile mit höherer Distanz als die eigene.
create or replace function public.my_worldwide_rank()
returns integer language sql security invoker stable as $$
  select 1 + count(*)::int
    from public.profiles p
   where p.best_distance > coalesce(
           (select best_distance from public.profiles where id = auth.uid()), -1);
$$;
