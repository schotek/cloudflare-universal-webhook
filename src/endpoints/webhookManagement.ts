import { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import customersData from "../data/customers.json";

// Valid webhook types
const VALID_TYPES = ["esl"] as const;

// TTL for delete logs: 90 days in seconds
const DELETE_LOG_TTL = 90 * 24 * 60 * 60;

/**
 * Format date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
	return date.toISOString().split("T")[0];
}

/**
 * Helper function to find webhook key by webhookId
 */
async function findWebhookKeyById(bucket: R2Bucket, webhookId: string, type?: string): Promise<string | null> {
	const prefix = type || "";
	let cursor: string | undefined;

	do {
		const listResult = await bucket.list({
			prefix: prefix || undefined,
			limit: 1000,
			cursor,
		});

		for (const obj of listResult.objects) {
			// Check if the filename contains the webhookId
			const filename = obj.key.split("/").pop() || "";
			if (filename.startsWith(webhookId)) {
				return obj.key;
			}
		}

		cursor = listResult.truncated ? listResult.cursor : undefined;
	} while (cursor);

	return null;
}

/**
 * Validates UUID format
 */
function isValidUUID(str: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

/**
 * List webhooks stored in R2
 * GET /manage/webhooks?type=esl&customer_id=xxx&date=2024-01-07&limit=100&cursor=xxx
 */
export const listWebhooks = async (c: Context<{ Bindings: Env }>) => {
	const type = c.req.query("type");
	const customer_id = c.req.query("customer_id");
	const date = c.req.query("date");
	const limitStr = c.req.query("limit");
	const cursor = c.req.query("cursor");

	// Validate type if provided
	if (type && !VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) {
		throw new HTTPException(400, { message: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}` });
	}

	// Validate date format if provided
	if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new HTTPException(400, { message: "Date must be in YYYY-MM-DD format" });
	}

	// Parse and validate limit
	const limit = limitStr ? Math.min(Math.max(parseInt(limitStr, 10) || 100, 1), 1000) : 100;

	// Build prefix for R2 listing
	let prefix = "";
	if (type) {
		prefix = type;
		if (customer_id) {
			prefix += `/${customer_id}`;
			if (date) {
				prefix += `/${date}`;
			}
		}
	}

	const listResult = await c.env.WEBHOOK_BUCKET.list({
		prefix: prefix || undefined,
		limit,
		cursor: cursor || undefined,
	});

	const webhooks = await Promise.all(
		listResult.objects.map(async (obj) => {
			// Get object metadata
			const headResult = await c.env.WEBHOOK_BUCKET.head(obj.key);
			const customMetadata = headResult?.customMetadata || {};

			return {
				webhookId: customMetadata.webhookId || obj.key.split("/").pop()?.replace(/\.[^.]+$/, "") || "",
				type: customMetadata.type || obj.key.split("/")[0] || "",
				customerId: customMetadata.customerId || obj.key.split("/")[1] || "",
				contentType: headResult?.httpMetadata?.contentType || "application/octet-stream",
				receivedAt: customMetadata.receivedAt || obj.uploaded.toISOString(),
				payloadSize: obj.size,
			};
		})
	);

	return c.json({
		success: true,
		webhooks,
		truncated: listResult.truncated,
		cursor: listResult.truncated ? listResult.cursor : undefined,
	});
};

/**
 * Download a specific webhook payload
 * GET /manage/webhooks/:webhookId
 */
export const downloadWebhook = async (c: Context<{ Bindings: Env }>) => {
	const webhookId = c.req.param("webhookId");
	const type = c.req.query("type");

	if (!webhookId || !isValidUUID(webhookId)) {
		throw new HTTPException(400, { message: "Invalid webhookId. Must be a valid UUID" });
	}

	// Validate type if provided
	if (type && !VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) {
		throw new HTTPException(400, { message: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}` });
	}

	// Find the key by webhookId
	const key = await findWebhookKeyById(c.env.WEBHOOK_BUCKET, webhookId, type);

	if (!key) {
		throw new HTTPException(404, { message: "Webhook not found" });
	}

	const object = await c.env.WEBHOOK_BUCKET.get(key);

	if (!object) {
		throw new HTTPException(404, { message: "Webhook not found" });
	}

	const contentType = object.httpMetadata?.contentType || "application/octet-stream";

	return new Response(object.body, {
		headers: {
			"Content-Type": contentType,
			"X-Webhook-Id": object.customMetadata?.webhookId || "",
			"X-Received-At": object.customMetadata?.receivedAt || "",
		},
	});
};

/**
 * Delete a specific webhook
 * DELETE /manage/webhooks/:webhookId
 */
export const deleteWebhook = async (c: Context<{ Bindings: Env }>) => {
	const webhookId = c.req.param("webhookId");
	const type = c.req.query("type");

	if (!webhookId || !isValidUUID(webhookId)) {
		throw new HTTPException(400, { message: "Invalid webhookId. Must be a valid UUID" });
	}

	// Validate type if provided
	if (type && !VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) {
		throw new HTTPException(400, { message: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}` });
	}

	// Find the key by webhookId
	const key = await findWebhookKeyById(c.env.WEBHOOK_BUCKET, webhookId, type);

	if (!key) {
		throw new HTTPException(404, { message: "Webhook not found" });
	}

	await c.env.WEBHOOK_BUCKET.delete(key);

	// Log deletion to KV (non-blocking)
	const sourceIp =
		c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || null;
	const userAgent = c.req.header("User-Agent") || null;

	const now = new Date();
	const dateStr = formatDate(now);
	const timestamp = now.getTime();
	const kvKey = `delete:${dateStr}:${timestamp}:${webhookId}`;

	const deleteLogValue = {
		webhookId,
		deletedKey: key,
		sourceIp,
		userAgent,
		timestamp: now.toISOString(),
	};

	c.executionCtx.waitUntil(
		c.env.AUDIT_KV.put(kvKey, JSON.stringify(deleteLogValue), { expirationTtl: DELETE_LOG_TTL }).catch((error) =>
			console.error("Delete logging failed:", error)
		)
	);

	return c.json({
		success: true,
		message: "Webhook deleted successfully",
		webhookId,
	});
};

/**
 * List customers
 * GET /manage/customers
 */
export const listCustomers = async (c: Context<{ Bindings: Env }>) => {
	return c.json({
		success: true,
		...customersData,
	});
};

// Audit log entry type
interface AuditLogEntry {
	method: string;
	path: string;
	statusCode: number;
	customerId: string | null;
	sourceIp: string | null;
	userAgent: string | null;
	contentType: string | null;
	requestSize: number | null;
	responseTimeMs: number;
	errorMessage: string | null;
	webhookId: string | null;
	timestamp: string;
}

/**
 * List audit logs from KV
 * GET /manage/audit?customer_id=xxx&status_code=404&from=2024-01-01&to=2024-01-31&limit=100
 *
 * Note: KV doesn't support SQL-like queries, so filtering is done in code.
 * - from/to: Uses KV prefix listing by date
 * - customer_id, status_code: Filtered in code after fetching
 */
export const listAuditLogs = async (c: Context<{ Bindings: Env }>) => {
	const customerId = c.req.query("customer_id");
	const statusCode = c.req.query("status_code");
	const from = c.req.query("from");
	const to = c.req.query("to");
	const limitStr = c.req.query("limit");

	// Validate date formats
	const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
	if (from && !dateRegex.test(from)) {
		throw new HTTPException(400, { message: "Invalid 'from' date format. Use YYYY-MM-DD" });
	}
	if (to && !dateRegex.test(to)) {
		throw new HTTPException(400, { message: "Invalid 'to' date format. Use YYYY-MM-DD" });
	}

	// Parse limit
	const limit = limitStr ? Math.min(Math.max(parseInt(limitStr, 10) || 100, 1), 1000) : 100;

	// Build prefix for KV listing
	// If from date is specified, start from that date; otherwise list all audit logs
	const prefix = "audit:";

	// Collect logs from KV
	const logs: AuditLogEntry[] = [];
	let cursor: string | undefined;
	const statusCodeNum = statusCode ? parseInt(statusCode, 10) : null;

	// Parse date bounds
	const fromDate = from ? new Date(from + "T00:00:00Z") : null;
	const toDate = to ? new Date(to + "T23:59:59Z") : null;

	do {
		const listResult = await c.env.AUDIT_KV.list({
			prefix,
			limit: 1000,
			cursor,
		});

		for (const key of listResult.keys) {
			// Parse date from key: audit:{YYYY-MM-DD}:{timestamp}:{uuid}
			const parts = key.name.split(":");
			if (parts.length < 3) continue;

			const keyDate = parts[1];

			// Date filtering based on key
			if (fromDate && keyDate < from!) continue;
			if (toDate && keyDate > to!) continue;

			// Fetch the value
			const value = await c.env.AUDIT_KV.get(key.name);
			if (!value) continue;

			const entry = JSON.parse(value) as AuditLogEntry;

			// Apply filters
			if (customerId && entry.customerId !== customerId) continue;
			if (statusCodeNum !== null && entry.statusCode !== statusCodeNum) continue;

			logs.push(entry);

			// Stop if we have enough
			if (logs.length >= limit) break;
		}

		cursor = listResult.list_complete ? undefined : listResult.cursor;
	} while (cursor && logs.length < limit);

	// Sort by timestamp descending (newest first)
	logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

	return c.json({
		success: true,
		logs: logs.slice(0, limit),
		count: logs.length,
	});
};
