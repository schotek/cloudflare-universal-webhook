import { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import customersData from "../data/customers.json";

// Valid webhook types
const VALID_TYPES = ["esl"] as const;

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

	// Log deletion to delete_log table (non-blocking)
	const sourceIp =
		c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || null;
	const userAgent = c.req.header("User-Agent") || null;

	c.executionCtx.waitUntil(
		c.env.DB.prepare(
			`INSERT INTO delete_log (webhook_id, deleted_key, source_ip, user_agent)
			 VALUES (?, ?, ?, ?)`
		)
			.bind(webhookId, key, sourceIp, userAgent)
			.run()
			.catch((error) => console.error("Delete logging failed:", error))
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

/**
 * List audit logs
 * GET /manage/audit?customer_id=xxx&status_code=404&from=2024-01-01&to=2024-01-31&limit=100&offset=0
 */
export const listAuditLogs = async (c: Context<{ Bindings: Env }>) => {
	const customerId = c.req.query("customer_id");
	const statusCode = c.req.query("status_code");
	const from = c.req.query("from");
	const to = c.req.query("to");
	const limitStr = c.req.query("limit");
	const offsetStr = c.req.query("offset");

	// Validate date formats
	const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
	if (from && !dateRegex.test(from)) {
		throw new HTTPException(400, { message: "Invalid 'from' date format. Use YYYY-MM-DD" });
	}
	if (to && !dateRegex.test(to)) {
		throw new HTTPException(400, { message: "Invalid 'to' date format. Use YYYY-MM-DD" });
	}

	// Parse limit and offset
	const limit = limitStr ? Math.min(Math.max(parseInt(limitStr, 10) || 100, 1), 1000) : 100;
	const offset = offsetStr ? Math.max(parseInt(offsetStr, 10) || 0, 0) : 0;

	// Build query
	let query = "SELECT * FROM audit_log WHERE 1=1";
	const params: (string | number)[] = [];

	if (customerId) {
		query += " AND customer_id = ?";
		params.push(customerId);
	}

	if (statusCode) {
		query += " AND status_code = ?";
		params.push(parseInt(statusCode, 10));
	}

	if (from) {
		query += " AND timestamp >= ?";
		params.push(from + " 00:00:00");
	}

	if (to) {
		query += " AND timestamp <= ?";
		params.push(to + " 23:59:59");
	}

	query += " ORDER BY timestamp DESC LIMIT ? OFFSET ?";
	params.push(limit, offset);

	// Execute query
	const result = await c.env.DB.prepare(query).bind(...params).all();

	// Get total count for pagination
	let countQuery = "SELECT COUNT(*) as total FROM audit_log WHERE 1=1";
	const countParams: (string | number)[] = [];

	if (customerId) {
		countQuery += " AND customer_id = ?";
		countParams.push(customerId);
	}

	if (statusCode) {
		countQuery += " AND status_code = ?";
		countParams.push(parseInt(statusCode, 10));
	}

	if (from) {
		countQuery += " AND timestamp >= ?";
		countParams.push(from + " 00:00:00");
	}

	if (to) {
		countQuery += " AND timestamp <= ?";
		countParams.push(to + " 23:59:59");
	}

	const countResult = await c.env.DB.prepare(countQuery).bind(...countParams).first<{ total: number }>();

	return c.json({
		success: true,
		logs: result.results,
		pagination: {
			total: countResult?.total || 0,
			limit,
			offset,
			hasMore: offset + limit < (countResult?.total || 0),
		},
	});
};
