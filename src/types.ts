import type { Context } from "hono";

export type AppContext = Context<{ Bindings: Env }>;

export interface WebhookResponse {
	success: boolean;
	webhookId: string;
	message: string;
	storagePath: string;
}

export interface WebhookMetadata {
	webhookId: string;
	type: string;
	customerId: string;
	contentType: string;
	receivedAt: string;
	sourceIp: string;
	payloadSize: number;
}
