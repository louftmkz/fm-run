-- Härtung: expliziter search_path auf allen Ranking-Funktionen (Supabase Advisor 0011).
-- Alle internen Referenzen sind bereits schema-qualifiziert (public.* / auth.uid()),
-- daher ist search_path = '' sicher.

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.submit_score(p_distance integer)
returns integer language sql security invoker set search_path = '' as $$
  update public.profiles
     set best_distance = greatest(best_distance, p_distance)
   where id = auth.uid()
  returning best_distance;
$$;

create or replace function public.friends_leaderboard()
returns table(handle text, best_distance integer, is_me boolean)
language sql security invoker stable set search_path = '' as $$
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

create or replace function public.my_worldwide_rank()
returns integer language sql security invoker stable set search_path = '' as $$
  select 1 + count(*)::int
    from public.profiles p
   where p.best_distance > coalesce(
           (select best_distance from public.profiles where id = auth.uid()), -1);
$$;
