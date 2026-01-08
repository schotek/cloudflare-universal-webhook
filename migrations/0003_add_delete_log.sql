-- Migration number: 0003 	 2025-01-08
-- Delete log table for tracking webhook deletions

CREATE TABLE IF NOT EXISTS delete_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    webhook_id TEXT NOT NULL,
    deleted_key TEXT NOT NULL,
    source_ip TEXT,
    user_agent TEXT
);

CREATE INDEX idx_delete_timestamp ON delete_log(timestamp);
CREATE INDEX idx_delete_webhook ON delete_log(webhook_id);
