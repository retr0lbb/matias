import { BadGatewayException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ClassroomNotConnectedError, ClassroomPermissionError } from "./classroom.errors.js";

const REQUEST_TIMEOUT_MS = 10_000;
const logger = new Logger("GoogleHttp");

export interface GoogleRequest {
	accessToken: string;
	method: "GET" | "POST";
	url: string;
	/** Sent as is; a plain object is sent as JSON. */
	body?: object | string;
	contentType?: string;
}

/**
 * Calls a Google API with the user's access token and maps failures:
 * 404 → null, 401 → ClassroomNotConnectedError, 403 → ClassroomPermissionError,
 * no response → 503, anything else → 502. Only the status and the URL path are
 * logged, never bodies (they can carry student data).
 */
export async function googleRequest<T>(request: GoogleRequest): Promise<T | null> {
	const headers: Record<string, string> = {
		accept: "application/json",
		authorization: `Bearer ${request.accessToken}`,
	};
	let body: string | undefined;
	if (typeof request.body === "string") {
		body = request.body;
		headers["content-type"] = request.contentType ?? "text/plain";
	} else if (request.body !== undefined) {
		body = JSON.stringify(request.body);
		headers["content-type"] = "application/json";
	}

	const path = new URL(request.url).pathname;
	let response: Response;
	try {
		response = await fetch(request.url, {
			method: request.method,
			headers,
			body,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		logger.error(
			`Google ${request.method} ${path} did not respond: ${error instanceof Error ? error.message : String(error)}`,
		);
		throw new ServiceUnavailableException("Google is unavailable");
	}

	if (response.status === 404) return null;
	if (response.status === 401) throw new ClassroomNotConnectedError("Google refused the access token");
	if (response.status === 403) throw new ClassroomPermissionError();
	if (!response.ok) {
		logger.error(`Google ${request.method} ${path} failed with ${response.status}`);
		throw new BadGatewayException("Google API error");
	}

	return (await response.json()) as T;
}
