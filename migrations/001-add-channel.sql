-- Migration 001: Add channel tracking to memories
-- Version: 0.5.0
-- Date: 2026-03-16

ALTER TABLE memories ADD COLUMN channel TEXT DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_memories_channel ON memories(channel);
