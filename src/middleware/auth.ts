import { MiddlewareHandler } from "hono";

/**
 * Validates the client IP against a comma-separated list of allowed IPs.
 * If ALLOWED_IPS is empty, all IPs are allowed.
 */
export const ipValidation: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
	const allowedIps = c.env.ALLOWED_IPS as string;

	// If no IPs configured, skip validation
	if (!allowedIps || allowedIps.trim() === "") {
		return next();
	}

	// Get client IP from CF-Connecting-IP header (Cloudflare provides this)
	const clientIp =
		c.req.header("CF-Connecting-IP") ||
		c.req.header("X-Forwarded-For")?.split(",")[0]?.trim();

	if (!clientIp) {
		return c.json(
			{
				success: false,
				errors: [{ code: 4031, message: "Unable to determine client IP address" }],
			},
			403
		);
	}

	const allowedIpList = allowedIps
		.split(",")
		.map((ip: string) => ip.trim())
		.filter((ip: string) => ip !== "");

	if (!allowedIpList.includes(clientIp)) {
		return c.json(
			{
				success: false,
				errors: [{ code: 4032, message: "IP address not allowed" }],
			},
			403
		);
	}

	return next();
};

/**
 * Validates per-customer API token from the Authorization header.
 * Each customer_id has its own token defined in CUSTOMER_TOKENS JSON.
 * Format: {"customer-123":"token-abc","customer-456":"token-xyz"}
 */
export const tokenAuthentication: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
	const customerTokensJson = c.env.CUSTOMER_TOKENS as string;

	// If no tokens configured, skip validation
	if (!customerTokensJson || customerTokensJson.trim() === "") {
		return next();
	}

	// Get customer_id from URL parameter
	const customerId = c.req.param("customer_id");
	if (!customerId) {
		return c.json(
			{
				success: false,
				errors: [{ code: 4003, message: "Missing customer_id" }],
			},
			400
		);
	}

	// Parse JSON with tokens
	let customerTokens: Record<string, string>;
	try {
		customerTokens = JSON.parse(customerTokensJson);
	} catch {
		console.error("Invalid CUSTOMER_TOKENS JSON");
		return c.json(
			{
				success: false,
				errors: [{ code: 5002, message: "Server configuration error" }],
			},
			500
		);
	}

	// Get expected token for this customer
	const expectedToken = customerTokens[customerId];
	if (!expectedToken) {
		return c.json(
			{
				success: false,
				errors: [{ code: 4033, message: "Unknown customer" }],
			},
			403
		);
	}

	// Validate Authorization header
	const authHeader = c.req.header("Authorization");
	if (!authHeader) {
		return c.json(
			{
				success: false,
				errors: [{ code: 4011, message: "Authorization header is required" }],
			},
			401
		);
	}

	// Support both "Bearer <token>" and raw token formats
	const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

	// Use timing-safe comparison to prevent timing attacks
	if (!timingSafeEqual(token, expectedToken)) {
		return c.json(
			{
				success: false,
				errors: [{ code: 4012, message: "Invalid API token for this customer" }],
			},
			401
		);
	}

	return next();
};

/**
 * Validates the S2S token from the Authorization header.
 * Used for server-to-server management endpoints.
 */
export const s2sAuthentication: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
	const expectedToken = c.env.S2S_TOKEN as string;

	// If no token configured, skip validation
	if (!expectedToken || expectedToken.trim() === "") {
		return next();
	}

	const authHeader = c.req.header("Authorization");

	if (!authHeader) {
		return c.json(
			{
				success: false,
				errors: [{ code: 4011, message: "Authorization header is required" }],
			},
			401
		);
	}

	// Support both "Bearer <token>" and raw token formats
	const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

	// Use timing-safe comparison to prevent timing attacks
	if (!timingSafeEqual(token, expectedToken)) {
		return c.json(
			{
				success: false,
				errors: [{ code: 4012, message: "Invalid S2S token" }],
			},
			401
		);
	}

	return next();
};


/**
 * Timing-safe string comparison to prevent timing attacks
 */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}

	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);

	let result = 0;
	for (let i = 0; i < aBytes.length; i++) {
		result |= aBytes[i] ^ bBytes[i];
	}

	return result === 0;
}
