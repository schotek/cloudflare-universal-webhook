-- Migration number: 0002 	 2025-01-08
-- Audit log table for tracking all requests

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    customer_id TEXT,
    source_ip TEXT,
    user_agent TEXT,
    content_type TEXT,
    request_size INTEGER,
    response_time_ms INTEGER,
    error_message TEXT,
    webhook_id TEXT
);

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_customer ON audit_log(customer_id);
CREATE INDEX idx_audit_status ON audit_log(status_code);
