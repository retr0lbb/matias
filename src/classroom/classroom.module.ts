import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DocumentsModule } from "../documents/documents.module.js";
import { ClassroomClient } from "./classroom.client.js";
import { ClassroomController } from "./classroom.controller.js";
import { ClassroomToolsService } from "./classroom-tools.service.js";
import { DriveClient } from "./drive.client.js";
import { GoogleIntegrationService } from "./google-integration.service.js";
import { TokenCipher } from "./token-cipher.js";

@Module({
	imports: [ConfigModule, DocumentsModule],
	controllers: [ClassroomController],
	providers: [
		TokenCipher,
		GoogleIntegrationService,
		ClassroomClient,
		DriveClient,
		ClassroomToolsService,
	],
	exports: [GoogleIntegrationService, ClassroomToolsService],
})
export class ClassroomModule {}
