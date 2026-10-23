import { Body, Controller, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { Public, SignInService } from '@nestjs/authentication';

@Controller('auth')
export class AuthController {
    constructor(
        private readonly authService: AuthService,
        private readonly signInService: SignInService
    ){}

    @Public()
    @Post("/register")
    async registerUser(@Body() body: {email: string, name: string, password: string}){
        const user = await this.authService.createAccount(body)
        await this.signInService.signIn(user.id, {method: "password"})
        return user
    }

    @Public()
    @Post("/login")
    @HttpCode(200)
    async loginUser(@Body() body: {email: string, password: string}){
        const user = await this.authService.logInAccount(body)
        
        if(!user){
            throw new UnauthorizedException("Invalid Email or password")
        }

        const { session } = await this.signInService.signIn(user.id, {method: "password"})
        console.log(session)

        return { mfaRequired: session.mfa === 'pending' }
    }
}
