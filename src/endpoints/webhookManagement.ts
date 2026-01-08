import { Context } from "hono";
import { HTTPException } from "hono/http-exception";

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

	return c.json({
		success: true,
		message: "Webhook deleted successfully",
		webhookId,
	});
};
