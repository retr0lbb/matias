import { randomUUID } from "node:crypto";
import { BadGatewayException, Injectable } from "@nestjs/common";
import { googleRequest } from "./google-http.js";

const UPLOAD_URL =
	"https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink";

export interface DriveFile {
	id: string;
	webViewLink?: string;
}

/** Uploads files to the teacher's Drive (`drive.file`: only files this app creates). */
@Injectable()
export class DriveClient {
	async uploadPdf(accessToken: string, name: string, pdf: Buffer): Promise<DriveFile> {
		const boundary = `matias-${randomUUID()}`;
		const metadata = JSON.stringify({ name, mimeType: "application/pdf" });

		// multipart/related: JSON metadata part, then the file part (base64).
		const body = [
			`--${boundary}`,
			"Content-Type: application/json; charset=UTF-8",
			"",
			metadata,
			`--${boundary}`,
			"Content-Type: application/pdf",
			"Content-Transfer-Encoding: base64",
			"",
			pdf.toString("base64"),
			`--${boundary}--`,
			"",
		].join("\r\n");

		const file = await googleRequest<DriveFile>({
			accessToken,
			method: "POST",
			url: UPLOAD_URL,
			body,
			contentType: `multipart/related; boundary=${boundary}`,
		});

		if (!file?.id) throw new BadGatewayException("Drive upload returned no file");
		return file;
	}
}
