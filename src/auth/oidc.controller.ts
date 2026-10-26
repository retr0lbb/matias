import { OidcService, Public } from "@nestjs/authentication";
import { Controller, Get, Query, Redirect } from "@nestjs/common";


@Public()
@Controller("auth/oidc")
export class OidcController {
    constructor(
        private readonly oidcService: OidcService,
    ) {}

    @Get("google/login")
    @Redirect()
    login(@Query("redirectTo") redirectTo?: string){
        return this.oidcService.start("google", {redirectTo})
    }

    @Get("google/callback")
    @Redirect()
    callback(
        @Query() query: Record<string, string>,
    ) {
        return this.oidcService.finish("google", query);
    }
}