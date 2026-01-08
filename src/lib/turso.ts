import { createClient, Client } from "@libsql/client/web";

export function getTursoClient(env: Env): Client | null {
	if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
		console.warn("Turso credentials not configured");
		return null;
	}
	return createClient({
		url: env.TURSO_DATABASE_URL,
		authToken: env.TURSO_AUTH_TOKEN,
	});
}

export interface AuditLogRow {
	id: string;
	method: string;
	path: string;
	status_code: number;
	customer_id: string | null;
	source_ip: string | null;
	user_agent: string | null;
	content_type: string | null;
	request_size: number | null;
	response_time_ms: number;
	error_message: string | null;
	webhook_id: string | null;
	timestamp: string;
}

export async function insertAuditLog(client: Client, log: AuditLogRow): Promise<void> {
	await client.execute({
		sql: `INSERT INTO audit_logs (id, method, path, status_code, customer_id, source_ip,
			user_agent, content_type, request_size, response_time_ms, error_message, webhook_id, timestamp)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			log.id,
			log.method,
			log.path,
			log.status_code,
			log.customer_id,
			log.source_ip,
			log.user_agent,
			log.content_type,
			log.request_size,
			log.response_time_ms,
			log.error_message,
			log.webhook_id,
			log.timestamp,
		],
	});
}
