import { OidcService, Public } from "@nestjs/authentication";
import { Controller, Get, Query, Redirect } from "@nestjs/common";

/** Provider of "Connect Classroom" (src/app.module.ts). Link only: it never signs anyone in. */
export const CLASSROOM_PROVIDER = "google-classroom";

// Public: the library itself requires a signed-in session for the link flow
// (401 otherwise) and refuses one started cross-site.
@Public()
@Controller("auth/oidc")
export class OidcController {
	constructor(private readonly oidcService: OidcService) {}

	@Get("google/login")
	@Redirect()
	login(@Query("redirectTo") redirectTo?: string) {
		return this.oidcService.start("google", { redirectTo });
	}

	@Get("google/callback")
	@Redirect()
	callback(@Query() query: Record<string, string>) {
		return this.oidcService.finish("google", query);
	}

	/** Starts "Connect Classroom" for the signed-in user. */
	@Get("google-classroom/connect")
	@Redirect()
	connectClassroom(@Query("redirectTo") redirectTo?: string) {
		return this.oidcService.start(CLASSROOM_PROVIDER, { redirectTo, link: true });
	}

	@Get("google-classroom/callback")
	@Redirect()
	classroomCallback(@Query() query: Record<string, string>) {
		return this.oidcService.finish(CLASSROOM_PROVIDER, query);
	}
}
