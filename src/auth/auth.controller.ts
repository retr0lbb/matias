import { EmailVerificationService, Public, SignInService } from "@nestjs/authentication";
import { Body, Controller, HttpCode, Post, UnauthorizedException } from "@nestjs/common";
import { AuthService } from "./auth.service.js";

@Controller("auth")
export class AuthController {
	constructor(
		private readonly authService: AuthService,
		private readonly signInService: SignInService,
		private readonly emailVerificationService: EmailVerificationService,
	) {}

	@Public()
	@Post("/register")
	async registerUser(@Body() body: { email: string; name: string; password: string }) {
		const user = await this.authService.createAccount(body);
		await this.signInService.signIn(user.id, { method: "password" });
		await this.emailVerificationService.send(user);
		return user;
	}

	@Public()
	@Post("/login")
	@HttpCode(200)
	async loginUser(@Body() body: { email: string; password: string }) {
		const user = await this.authService.logInAccount(body);

		if (!user) {
			throw new UnauthorizedException("Invalid Email or password");
		}

		const { session } = await this.signInService.signIn(user.id, { method: "password" });
		console.log(session);

		return { mfaRequired: session.mfa === "pending" };
	}

	/**
	 * Ends this browser's session on the spot: the session row is deleted, so
	 * the cookie stops working immediately, and the cookie is cleared. Public
	 * and idempotent, so an expired or missing session still gets its cookie
	 * cleared instead of a 401.
	 */
	@Public()
	@Post("/logout")
	@HttpCode(204)
	async logoutUser(): Promise<void> {
		await this.signInService.signOut();
	}
}
