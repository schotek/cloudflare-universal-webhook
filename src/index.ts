import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ipValidation, tokenAuthentication, s2sAuthentication } from "./middleware/auth";
import { auditMiddleware } from "./middleware/audit";
import { handleWebhook } from "./endpoints/webhook";
import { listWebhooks, downloadWebhook, deleteWebhook, listCustomers, listAuditLogs } from "./endpoints/webhookManagement";
import { getTursoClient } from "./lib/turso";

const app = new Hono<{ Bindings: Env }>();

// Global error handler
app.onError((err, c) => {
	// Store error message for audit logging
	if (err instanceof HTTPException) {
		c.set("auditErrorMessage", err.message);
		return c.json(
			{
				success: false,
				errors: [{ code: err.status, message: err.message }],
			},
			err.status
		);
	}

	console.error("Global error handler caught:", err);
	c.set("auditErrorMessage", "Internal Server Error");

	return c.json(
		{
			success: false,
			errors: [{ code: 7000, message: "Internal Server Error" }],
		},
		500
	);
});

// Apply audit middleware to all routes
app.use("*", auditMiddleware);

// Redirect to main website
app.get("/", (c) => {
	return c.redirect("https://www.proficenovky.cz/", 302);
});

// Webhook route with middleware
app.post("/webhook/:type/:customer_id", ipValidation, tokenAuthentication, handleWebhook);

// Management routes with middleware
app.get("/manage/customers", s2sAuthentication, listCustomers);
app.get("/manage/webhooks", s2sAuthentication, listWebhooks);
app.get("/manage/webhooks/:webhookId", s2sAuthentication, downloadWebhook);
app.delete("/manage/webhooks/:webhookId", s2sAuthentication, deleteWebhook);
app.get("/manage/audit", s2sAuthentication, listAuditLogs);

// Export worker with scheduled handler for Turso cleanup
export default {
	fetch: app.fetch,

	// Scheduled handler for 30-day Turso audit log retention cleanup
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		const tursoClient = getTursoClient(env);
		if (!tursoClient) {
			console.log("Turso not configured, skipping retention cleanup");
			return;
		}

		try {
			const thirtyDaysAgo = new Date();
			thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

			const result = await tursoClient.execute({
				sql: "DELETE FROM audit_logs WHERE created_at < ?",
				args: [thirtyDaysAgo.toISOString()],
			});

			console.log(`Turso cleanup: deleted ${result.rowsAffected} rows`);
		} catch (error) {
			console.error("Turso retention cleanup failed:", error);
		}
	},
};
