import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { Authenticate, CurrentUser } from "@nestjs/authentication";
import { type User } from "../db/schemas/user.js";
import { RagService } from "./rag.service.js";

@Authenticate({ verifiedEmail: true })
@Controller("rag")
export class RagController {
  constructor(private readonly ragService: RagService) {}

  @Get("search")
  async search(
    @Query("query") query: string | undefined,
    @CurrentUser() user: User,
    @Query("documentId") documentId?: string,
    @Query("conversationId") conversationId?: string,
  ) {
    if (!query || query.trim().length === 0) {
      throw new BadRequestException("query is required");
    }

    const results = await this.ragService.search(query, user.id, {
      documentId,
      conversationId,
    });

    return { query, results };
  }
}
