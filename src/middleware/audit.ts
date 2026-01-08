import { MiddlewareHandler } from "hono";

// Extend Hono context to store audit data
declare module "hono" {
	interface ContextVariableMap {
		auditWebhookId?: string;
		auditErrorMessage?: string;
	}
}

// TTL for audit logs: 30 days in seconds
const AUDIT_TTL = 30 * 24 * 60 * 60;

/**
 * Format date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
	return date.toISOString().split("T")[0];
}

/**
 * Audit logging middleware
 * Logs all requests to KV store (except audit endpoint itself)
 */
export const auditMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
	const start = Date.now();

	// Execute the request
	await next();

	// Skip logging for audit endpoint to avoid recursion/noise
	if (c.req.path === "/manage/audit") {
		return;
	}

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

	// Build KV key: audit:{date}:{timestamp_ms}:{uuid}
	const now = new Date();
	const dateStr = formatDate(now);
	const timestamp = now.getTime();
	const uuid = crypto.randomUUID();
	const key = `audit:${dateStr}:${timestamp}:${uuid}`;

	// Build value
	const value = {
		method,
		path,
		statusCode,
		customerId,
		sourceIp,
		userAgent,
		contentType,
		requestSize,
		responseTimeMs: duration,
		errorMessage,
		webhookId,
		timestamp: now.toISOString(),
	};

	// Log to KV in background (non-blocking) with TTL
	c.executionCtx.waitUntil(
		c.env.AUDIT_KV.put(key, JSON.stringify(value), { expirationTtl: AUDIT_TTL }).catch((error) =>
			console.error("Audit logging failed:", error)
		)
	);
};
