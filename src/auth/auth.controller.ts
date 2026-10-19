import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service.js';

@Controller('auth')
export class AuthController {
    constructor(
        private readonly authService: AuthService
    ){}

    @Post("/register")
    async registerUser(@Body() body: {email: string, name: string, password: string}){
        await this.authService.createAccount(body)
    }

    @Post("/login")
    async loginUser(@Body() body: {email: string, password: string}){
        await this.authService.logInAccount(body)
    }
}
