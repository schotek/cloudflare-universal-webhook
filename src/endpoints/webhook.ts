import { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { WebhookMetadata } from "../types";

// Content-type to file extension mapping
const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
	"application/json": "json",
	"application/xml": "xml",
	"text/xml": "xml",
	"text/csv": "csv",
	"text/plain": "txt",
	"application/x-www-form-urlencoded": "form",
	"multipart/form-data": "form",
	"application/octet-stream": "bin",
};

// Valid webhook types
const VALID_TYPES = ["esl"] as const;

/**
 * Determines file extension from content-type header
 */
function getExtensionFromContentType(contentType: string | undefined): string {
	if (!contentType) {
		return "bin";
	}

	// Extract base content type (remove charset, boundary, etc.)
	const baseType = contentType.split(";")[0].trim().toLowerCase();

	return CONTENT_TYPE_EXTENSIONS[baseType] || "bin";
}

/**
 * Formats date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
	return date.toISOString().split("T")[0];
}

/**
 * Validates customer_id format
 */
function isValidCustomerId(customerId: string): boolean {
	return /^[a-zA-Z0-9_-]{1,64}$/.test(customerId);
}

/**
 * Handle incoming webhook requests
 * POST /webhook/:type/:customer_id
 */
export const handleWebhook = async (c: Context<{ Bindings: Env }>) => {
	const type = c.req.param("type");
	const customer_id = c.req.param("customer_id");

	// Validate type
	if (!type || !VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) {
		throw new HTTPException(400, { message: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}` });
	}

	// Validate customer_id format
	if (!customer_id || !isValidCustomerId(customer_id)) {
		throw new HTTPException(400, {
			message: "Customer ID must contain only alphanumeric characters, hyphens, and underscores (1-64 chars)",
		});
	}

	// Get raw body as ArrayBuffer to handle any content type
	const rawBody = await c.req.arrayBuffer();

	if (rawBody.byteLength === 0) {
		throw new HTTPException(400, { message: "Request body cannot be empty" });
	}

	// Generate webhook ID and storage path
	const webhookId = crypto.randomUUID();
	const dateFolder = formatDate(new Date());
	const contentType = c.req.header("Content-Type");
	const extension = getExtensionFromContentType(contentType);

	// R2 path: /{type}/{customer_id}/{YYYY-MM-DD}/{uuid}.{ext}
	const storagePath = `${type}/${customer_id}/${dateFolder}/${webhookId}.${extension}`;

	// Get client IP for metadata
	const sourceIp =
		c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";

	// Prepare metadata
	const metadata: WebhookMetadata = {
		webhookId,
		type,
		customerId: customer_id,
		contentType: contentType || "application/octet-stream",
		receivedAt: new Date().toISOString(),
		sourceIp,
		payloadSize: rawBody.byteLength,
	};

	try {
		// Store in R2 with metadata
		await c.env.WEBHOOK_BUCKET.put(storagePath, rawBody, {
			httpMetadata: {
				contentType: contentType || "application/octet-stream",
			},
			customMetadata: {
				webhookId: metadata.webhookId,
				type: metadata.type,
				customerId: metadata.customerId,
				receivedAt: metadata.receivedAt,
				sourceIp: metadata.sourceIp,
				payloadSize: metadata.payloadSize.toString(),
			},
		});
	} catch (error) {
		console.error("Failed to store webhook payload:", error);
		throw new HTTPException(500, { message: "Failed to store webhook payload" });
	}

	return c.json({
		success: true,
		webhookId,
		message: "Webhook received and stored successfully",
		storagePath,
	});
};
