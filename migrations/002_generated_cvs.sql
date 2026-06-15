-- Migration 002: Create generated_cvs table for AI CV history
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS generated_cvs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid REFERENCES candidates(id),
  vacancy_id bigint,
  vacancy_name text,
  candidate_name text NOT NULL,
  cv_content jsonb NOT NULL,
  full_text text NOT NULL,
  model_used text NOT NULL,
  prompt_tokens int,
  completion_tokens int,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_generated_cvs_candidate ON generated_cvs (candidate_id);
CREATE INDEX IF NOT EXISTS idx_generated_cvs_created ON generated_cvs (created_at DESC);
