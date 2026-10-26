import { AuthenticationRegistry, OAuthTokens, OidcAccountResolver, OidcProfile, OidcResolveContext } from "@nestjs/authentication";
import { AuthService } from "../auth.service.js";
import { ConflictException, ForbiddenException, Injectable } from "@nestjs/common";

@Injectable()
export class AccountLinker extends OidcAccountResolver{
    constructor(
        private readonly userService: AuthService,
        registry: AuthenticationRegistry
    ){
        super()
        registry.registerHandler("oidc", this)
    }

    async resolveUser(profile: OidcProfile, _tokens: OAuthTokens, _context: OidcResolveContext){
        if(!profile.email || !profile.emailVerified){
            throw new ForbiddenException(
                "A Google account with a verified email is required"
            );
        }

        const exists = await this.userService.findByGoogleSubject(
            profile.subject
        )

        if(exists){
            if (exists.loginProvider !== "GOOGLE") {
                throw new ConflictException("Invalid login provider");
            }

            return exists
        }

        const existingEmail = await this.userService.findByEmail(
            profile.email,
        );

        if(existingEmail && existingEmail.loginProvider === "LOCAL"){
            throw new ConflictException(
                "An account already exists. Sign in using your original method.",
            );
        }

        return this.userService.createGoogleUser({
            name: profile.name || profile.email,
            email: profile.email,
            subject: profile.subject
        })
    }
}