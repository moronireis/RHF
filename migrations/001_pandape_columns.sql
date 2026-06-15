-- Migration 001: Add Pandapé integration columns to candidates table
-- Run this in Supabase SQL Editor

ALTER TABLE candidates ADD COLUMN IF NOT EXISTS match_id bigint UNIQUE;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS vacancy_id bigint;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS vacancy_name text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS stage text DEFAULT 'new';
