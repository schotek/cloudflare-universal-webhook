import { ApiException, fromHono } from "chanfana";
import { Hono } from "hono";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { WebhookReceiver } from "./endpoints/webhook";
import { ipValidation, tokenAuthentication } from "./middleware/auth";

// Start a Hono app
const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
	if (err instanceof ApiException) {
		return c.json(
			{ success: false, errors: err.buildResponse() },
			err.status as ContentfulStatusCode
		);
	}

	console.error("Global error handler caught:", err);

	return c.json(
		{
			success: false,
			errors: [{ code: 7000, message: "Internal Server Error" }],
		},
		500
	);
});

// Setup OpenAPI registry
const openapi = fromHono(app, {
	docs_url: "/",
	schema: {
		info: {
			title: "Universal Webhook API",
			version: "1.0.0",
			description:
				"A universal webhook receiver that accepts payloads of any format (JSON, XML, CSV, etc.) and stores them securely in R2 storage. Features IP validation and API token authentication.",
		},
		security: [{ bearerAuth: [] }],
	} as const,
});

// Add security scheme to OpenAPI spec
openapi.registry.registerComponent("securitySchemes", "bearerAuth", {
	type: "http",
	scheme: "bearer",
	description: "API token - zadejte token bez prefixu 'Bearer'",
});

// Apply auth middleware to webhook routes
app.use("/webhook/*", ipValidation, tokenAuthentication);

// Register webhook endpoint
openapi.post("/webhook/:type/:customer_id", WebhookReceiver);

// Export the Hono app
export default app;
