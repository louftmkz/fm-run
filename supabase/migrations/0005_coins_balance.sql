-- Migration: Persistent coin balance per profile (Phase 1: collect only)
-- Adds coins_balance column to profiles and add_coins RPC for server-side increment.

-- 1. Schema: coins_balance column
ALTER TABLE public.profiles
  ADD COLUMN coins_balance bigint NOT NULL DEFAULT 0
  CHECK (coins_balance >= 0);

-- 2. RPC: add_coins (increment-only, with validation)
CREATE OR REPLACE FUNCTION public.add_coins(p_user_id uuid, p_delta integer)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_balance bigint;
BEGIN
  IF p_delta IS NULL OR p_delta < 0 THEN
    RAISE EXCEPTION 'invalid_delta';
  END IF;
  IF p_delta > 1000000 THEN
    RAISE EXCEPTION 'delta_too_large';
  END IF;

  UPDATE public.profiles
     SET coins_balance = coins_balance + p_delta,
         updated_at    = now()
   WHERE id = p_user_id
   RETURNING coins_balance INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  RETURN v_new_balance;
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_coins(uuid, integer) TO anon, authenticated;
