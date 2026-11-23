import {
	AuthenticationRegistry,
	OAuthTokens,
	OidcAccountResolver,
	OidcProfile,
	OidcResolveContext,
} from "@nestjs/authentication";
import { ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import { GoogleIntegrationService } from "../../classroom/google-integration.service.js";
import { AuthService } from "../auth.service.js";
import { CLASSROOM_PROVIDER } from "../oidc.controller.js";

@Injectable()
export class AccountLinker extends OidcAccountResolver {
	constructor(
		private readonly userService: AuthService,
		private readonly googleIntegration: GoogleIntegrationService,
		registry: AuthenticationRegistry,
	) {
		super();
		registry.registerHandler("oidc", this);
	}

	async resolveUser(profile: OidcProfile, tokens: OAuthTokens, context: OidcResolveContext) {
		if (profile.provider === CLASSROOM_PROVIDER) {
			return this.connectClassroom(profile, tokens, context);
		}

		if (!profile.email || !profile.emailVerified) {
			throw new ForbiddenException("A Google account with a verified email is required");
		}

		const exists = await this.userService.findByGoogleSubject(profile.subject);

		if (exists) {
			if (exists.loginProvider !== "GOOGLE") {
				throw new ConflictException("Invalid login provider");
			}

			return exists;
		}

		const existingEmail = await this.userService.findByEmail(profile.email);

		// Any other account with this email: a LOCAL one, or a GOOGLE one tied to
		// a different Google subject. Inserting would hit the unique email (500).
		if (existingEmail) {
			throw new ConflictException("An account already exists. Sign in using your original method.");
		}

		return this.userService.createGoogleUser({
			name: profile.name || profile.email,
			email: profile.email,
			subject: profile.subject,
		});
	}

	/**
	 * "Connect Classroom" stores the Google tokens on the signed-in user. The
	 * Google account can be any (a school account, say): it is not a login.
	 */
	private async connectClassroom(
		profile: OidcProfile,
		tokens: OAuthTokens,
		context: OidcResolveContext,
	) {
		if (!context.linkTo) {
			throw new ForbiddenException("Google Classroom can only be connected to a signed-in account");
		}

		await this.googleIntegration.save(context.linkTo.id, profile, tokens);
		return { id: context.linkTo.id };
	}
}
