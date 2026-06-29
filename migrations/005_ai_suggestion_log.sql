-- Migration 005 — AI Suggestion Log
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS ai_suggestion_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id),
  user_name text,
  candidate_name text,
  phone text,
  suggestion_text text NOT NULL,
  copied_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_log_user ON ai_suggestion_log(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_log_copied ON ai_suggestion_log(copied_at DESC);
