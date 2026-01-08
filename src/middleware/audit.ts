import { MiddlewareHandler } from "hono";

// Extend Hono context to store audit data
declare module "hono" {
	interface ContextVariableMap {
		auditWebhookId?: string;
		auditErrorMessage?: string;
	}
}

/**
 * Audit logging middleware
 * Logs all requests to D1 database
 */
export const auditMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
	const start = Date.now();

	// Execute the request
	await next();

	const duration = Date.now() - start;

	// Extract data from request/response
	const method = c.req.method;
	const path = c.req.path;
	const statusCode = c.res.status;

	// Extract customer_id from path if present (/webhook/:type/:customer_id)
	const pathParts = path.split("/");
	let customerId: string | null = null;
	if (pathParts[1] === "webhook" && pathParts.length >= 4) {
		customerId = pathParts[3];
	}

	// Get headers
	const sourceIp =
		c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || null;
	const userAgent = c.req.header("User-Agent") || null;
	const contentType = c.req.header("Content-Type") || null;
	const contentLength = c.req.header("Content-Length");
	const requestSize = contentLength ? parseInt(contentLength, 10) : null;

	// Get additional audit data set by handlers
	const webhookId = c.get("auditWebhookId") || null;
	const errorMessage = c.get("auditErrorMessage") || null;

	// Log to D1 (non-blocking)
	try {
		await c.env.DB.prepare(
			`INSERT INTO audit_log
			(method, path, status_code, customer_id, source_ip, user_agent, content_type, request_size, response_time_ms, error_message, webhook_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(
				method,
				path,
				statusCode,
				customerId,
				sourceIp,
				userAgent,
				contentType,
				requestSize,
				duration,
				errorMessage,
				webhookId
			)
			.run();
	} catch (error) {
		// Don't fail the request if audit logging fails
		console.error("Audit logging failed:", error);
	}
};

/**
 * Cleanup old audit logs (called by scheduled worker)
 * Deletes logs older than 30 days
 */
export async function cleanupAuditLogs(db: D1Database): Promise<number> {
	const result = await db
		.prepare("DELETE FROM audit_log WHERE timestamp < datetime('now', '-30 days')")
		.run();

	return result.meta.changes || 0;
}
