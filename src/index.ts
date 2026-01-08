import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ipValidation, tokenAuthentication, s2sAuthentication } from "./middleware/auth";
import { handleWebhook } from "./endpoints/webhook";
import { listWebhooks, downloadWebhook, deleteWebhook } from "./endpoints/webhookManagement";

const app = new Hono<{ Bindings: Env }>();

// Global error handler
app.onError((err, c) => {
	if (err instanceof HTTPException) {
		return c.json(
			{
				success: false,
				errors: [{ code: err.status, message: err.message }],
			},
			err.status
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

// Redirect to main website
app.get("/", (c) => {
	return c.redirect("https://www.proficenovky.cz/", 302);
});

// Webhook route with middleware
app.post("/webhook/:type/:customer_id", ipValidation, tokenAuthentication, handleWebhook);

// Management routes with middleware
app.get("/manage/webhooks", s2sAuthentication, listWebhooks);
app.get("/manage/webhooks/:webhookId", s2sAuthentication, downloadWebhook);
app.delete("/manage/webhooks/:webhookId", s2sAuthentication, deleteWebhook);

export default app;
