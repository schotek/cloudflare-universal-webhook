import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { AppContext, WebhookResponse, WebhookMetadata } from "../types";

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

export class WebhookReceiver extends OpenAPIRoute {
	public schema = {
		tags: ["Webhook"],
		summary: "Receive and store webhook payloads",
		description:
			"Receives webhook payloads of any format (JSON, XML, CSV, etc.) and stores them in R2 storage.",
		operationId: "webhook-receive",
		request: {
			params: z.object({
				type: z
					.string()
					.min(1)
					.max(64)
					.regex(/^[a-zA-Z0-9_-]+$/, {
						message: "Type must contain only alphanumeric characters, hyphens, and underscores",
					})
					.describe("Webhook type identifier (e.g., 'esl', 'stripe', 'custom')"),
				customer_id: z
					.string()
					.min(1)
					.max(64)
					.regex(/^[a-zA-Z0-9_-]+$/, {
						message:
							"Customer ID must contain only alphanumeric characters, hyphens, and underscores",
					})
					.describe("Customer identifier for organizing webhooks"),
			}),
		},
		responses: {
			"200": {
				description: "Webhook received and stored successfully",
				content: {
					"application/json": {
						schema: z.object({
							success: z.boolean(),
							webhookId: z.string().uuid(),
							message: z.string(),
							storagePath: z.string(),
						}),
					},
				},
			},
			"400": {
				description: "Bad request - empty payload or invalid parameters",
			},
			"401": {
				description: "Unauthorized - invalid or missing API token",
			},
			"403": {
				description: "Forbidden - IP address not allowed",
			},
		},
	};

	public async handle(c: AppContext): Promise<WebhookResponse> {
		const data = await this.getValidatedData<typeof this.schema>();
		const { type, customer_id } = data.params;

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
			c.req.header("CF-Connecting-IP") ||
			c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
			"unknown";

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

		return {
			success: true,
			webhookId,
			message: "Webhook received and stored successfully",
			storagePath,
		};
	}
}
