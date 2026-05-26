-- Migration: Email OTP to Handle + Password Authentication
-- Clean slate: Remove all existing user data
-- Add password_hash column to profiles
-- Add authentication RPC functions

-- 1. Delete all existing data (clean slate)
DELETE FROM friendships;
DELETE FROM profiles;

-- 2. Add password_hash column to profiles table
ALTER TABLE profiles
ADD COLUMN password_hash text NOT NULL DEFAULT '';

-- Remove default after adding column (we want it required for new inserts)
ALTER TABLE profiles
ALTER COLUMN password_hash DROP DEFAULT;

-- 3. RPC Function: Check if handle exists (case-insensitive)
CREATE OR REPLACE FUNCTION handle_exists(p_handle text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM profiles
    WHERE lower(handle) = lower(p_handle)
  );
END;
$$;

-- 4. RPC Function: Authenticate user with handle and password hash
CREATE OR REPLACE FUNCTION authenticate(p_handle text, p_password_hash text)
RETURNS TABLE (
  id uuid,
  handle text,
  best_distance integer,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.handle,
    p.best_distance,
    p.created_at
  FROM profiles p
  WHERE lower(p.handle) = lower(p_handle)
    AND p.password_hash = p_password_hash;
END;
$$;

-- Grant execute permissions on RPC functions
GRANT EXECUTE ON FUNCTION handle_exists TO anon, authenticated;
GRANT EXECUTE ON FUNCTION authenticate TO anon, authenticated;
