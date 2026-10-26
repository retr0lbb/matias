import { CurrentUser, EmailVerificationService, Public } from "@nestjs/authentication";
import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Post } from "@nestjs/common";
import { type User } from "../db/schemas/user.js";


@Controller("me")
export class MeController{
  @Get()
  me(@CurrentUser() user: User) {
    return user;
  }
}