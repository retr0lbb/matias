import type { GenerateContentParameters, GenerateContentResponse, Part } from "@google/genai";
import type { MockedFunction } from "vitest";
import type { ToolRuntime } from "../../shared/tools/tool-runtime.js";
import type { AIStreamChunk } from "../ai-provider.type.js";
import {
	type GeminiStreamClient,
	MAX_TOOL_ROUNDS,
	streamWithTools,
	type ToolLoopRequest,
} from "./gemini-tools.js";

const STARTED_AT = new Date("2026-11-22T12:00:00.000Z");
const DECLARATION = { name: "classroom_list_courses", description: "Lists classes." };

/** One streamed chunk carrying `parts`, plus usage on the last chunk of a round. */
const chunk = (
	parts: Part[],
	extra: Partial<GenerateContentResponse> = {},
): GenerateContentResponse =>
	({
		responseId: "resp-1",
		modelVersion: "gemini-x-001",
		candidates: [{ content: { role: "model", parts }, finishReason: undefined }],
		...extra,
	}) as GenerateContentResponse;

const usage = (prompt: number, output: number, thoughts = 0) => ({
	usageMetadata: {
		promptTokenCount: prompt,
		candidatesTokenCount: output,
		thoughtsTokenCount: thoughts,
		cachedContentTokenCount: 0,
		totalTokenCount: prompt + output + thoughts,
	},
});

const callPart = (name: string, args: Record<string, unknown> = {}, id = "call-1"): Part => ({
	functionCall: { id, name, args },
	thoughtSignature: "sig-123",
});

async function* streamOf(chunks: GenerateContentResponse[]) {
	for (const item of chunks) yield item;
}

const createClient = (rounds: GenerateContentResponse[][]) => {
	const generateContentStream = vi.fn(async (_params: GenerateContentParameters) =>
		streamOf(rounds.shift() ?? []),
	) as unknown as MockedFunction<GeminiStreamClient["models"]["generateContentStream"]>;
	return { client: { models: { generateContentStream } }, generateContentStream };
};

const createRuntime = (declarations = [DECLARATION]) => {
	const execute = vi.fn() as unknown as MockedFunction<ToolRuntime["execute"]>;
	return { runtime: { declarations, execute } satisfies ToolRuntime, execute };
};

const buildRequest = (overrides: Partial<ToolLoopRequest> = {}): ToolLoopRequest => ({
	model: "gemini-test",
	message: "quais são minhas turmas?",
	thinkingLevel: "LOW",
	config: { maxOutputTokens: 100, systemInstruction: "sys" },
	...overrides,
});

const collect = async (generator: AsyncGenerator<AIStreamChunk>) => {
	const chunks: AIStreamChunk[] = [];
	for await (const item of generator) chunks.push(item);
	return chunks;
};

const doneOf = (chunks: AIStreamChunk[]) => {
	const last = chunks.at(-1);
	if (last?.type !== "done") throw new Error("expected a done chunk last");
	return last.response;
};

describe("streamWithTools", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(STARTED_AT);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("should stream the answer in one round when the model calls no tool", async () => {
		const { client, generateContentStream } = createClient([
			[
				chunk([{ text: "pensando", thought: true }]),
				chunk([{ text: "Olá" }]),
				chunk([], {
					...usage(10, 2, 3),
					candidates: [{ content: { parts: [{ text: "!" }] }, finishReason: "STOP" }],
				} as Partial<GenerateContentResponse>),
			],
		]);
		const { runtime, execute } = createRuntime();

		const chunks = await collect(streamWithTools(client, buildRequest(), runtime, STARTED_AT));

		expect(chunks.slice(0, -1)).toEqual([
			{ type: "thinking", text: "pensando" },
			{ type: "text", text: "Olá" },
			{ type: "text", text: "!" },
		]);
		const response = doneOf(chunks);
		expect(response).toMatchObject({
			messageId: "resp-1",
			model: "gemini-x-001",
			modelName: "gemini-test",
			thinkingLevel: "LOW",
			status: "STOP",
			output_text: "Olá!",
			thinking_output: "pensando",
			toolCalls: [],
			created: STARTED_AT.toISOString(),
		});
		expect(response.tokens).toEqual({ prompt: 10, output: 2, thoughts: 3, cached: 0, total: 15 });
		expect(response.usage).toEqual({ total_input_tokens: 10, total_tokens: 15 });
		expect(execute).not.toHaveBeenCalled();
		expect(generateContentStream).toHaveBeenCalledTimes(1);
	});

	it("should offer the declarations and send the user message as the first content", async () => {
		const { client, generateContentStream } = createClient([[chunk([{ text: "ok" }])]]);
		const { runtime } = createRuntime();

		await collect(streamWithTools(client, buildRequest(), runtime, STARTED_AT));

		const params = generateContentStream.mock.calls[0]?.[0];
		expect(params?.model).toBe("gemini-test");
		expect(params?.contents).toEqual([
			{ role: "user", parts: [{ text: "quais são minhas turmas?" }] },
		]);
		expect(params?.config).toEqual({
			maxOutputTokens: 100,
			systemInstruction: "sys",
			tools: [{ functionDeclarations: [DECLARATION] }],
		});
	});

	it("should not offer tools when the runtime declares none", async () => {
		const { client, generateContentStream } = createClient([[chunk([{ text: "ok" }])]]);
		const { runtime } = createRuntime([]);

		await collect(streamWithTools(client, buildRequest(), runtime, STARTED_AT));

		expect(generateContentStream.mock.calls[0]?.[0].config).not.toHaveProperty("tools");
	});

	it("should run the called tool and send its result back when the model calls one", async () => {
		const call = callPart("classroom_list_courses", { page: 1 });
		const { client, generateContentStream } = createClient([
			[chunk([call], usage(10, 1))],
			[chunk([{ text: "Você tem 1 turma." }], usage(30, 5))],
		]);
		const { runtime, execute } = createRuntime();
		execute.mockResolvedValue({ courses: [{ id: "c1" }] });

		const chunks = await collect(streamWithTools(client, buildRequest(), runtime, STARTED_AT));

		expect(execute).toHaveBeenCalledWith("classroom_list_courses", { page: 1 });
		expect(chunks.slice(0, -1)).toEqual([
			{ type: "tool", name: "classroom_list_courses", status: "running" },
			{ type: "tool", name: "classroom_list_courses", status: "done" },
			{ type: "text", text: "Você tem 1 turma." },
		]);

		// The model turn goes back untouched (thought signature included), then the result.
		const second = generateContentStream.mock.calls[1]?.[0];
		expect(second?.contents).toEqual([
			{ role: "user", parts: [{ text: "quais são minhas turmas?" }] },
			{ role: "model", parts: [call] },
			{
				role: "user",
				parts: [
					{
						functionResponse: {
							id: "call-1",
							name: "classroom_list_courses",
							response: { courses: [{ id: "c1" }] },
						},
					},
				],
			},
		]);

		const response = doneOf(chunks);
		expect(response.output_text).toBe("Você tem 1 turma.");
		expect(response.tokens).toEqual({ prompt: 40, output: 6, thoughts: 0, cached: 0, total: 46 });
		expect(response.toolCalls).toEqual([
			{ name: "classroom_list_courses", ok: true, latencyMs: expect.any(Number) },
		]);
	});

	it("should run every call of a round in order when the model calls several", async () => {
		const { client } = createClient([
			[chunk([callPart("a", {}, "1"), callPart("b", {}, "2")])],
			[chunk([{ text: "pronto" }])],
		]);
		const { runtime, execute } = createRuntime();
		execute.mockResolvedValueOnce({ ok: 1 }).mockResolvedValueOnce({ error: "NOT_FOUND" });

		const chunks = await collect(streamWithTools(client, buildRequest(), runtime, STARTED_AT));

		expect(execute.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
		expect(chunks.filter((item) => item.type === "tool")).toEqual([
			{ type: "tool", name: "a", status: "running" },
			{ type: "tool", name: "a", status: "done" },
			{ type: "tool", name: "b", status: "running" },
			{ type: "tool", name: "b", status: "error" },
		]);
		expect(doneOf(chunks).toolCalls?.map((call) => call.ok)).toEqual([true, false]);
	});

	it("should pass empty args and name when the call leaves them out", async () => {
		const { client } = createClient([
			[chunk([{ functionCall: {} }])],
			[chunk([{ text: "ok" }])],
		]);
		const { runtime, execute } = createRuntime();
		execute.mockResolvedValue({ error: "UNKNOWN_TOOL" });

		await collect(streamWithTools(client, buildRequest(), runtime, STARTED_AT));

		expect(execute).toHaveBeenCalledWith("", {});
	});

	it("should stop offering tools after the round limit and force an answer", async () => {
		const rounds = Array.from({ length: MAX_TOOL_ROUNDS }, () => [
			chunk([callPart("classroom_list_courses")]),
		]);
		// Even if the model still asks for a tool in the last round, nothing runs.
		rounds.push([chunk([callPart("classroom_list_courses"), { text: "Resposta final" }])]);
		const { client, generateContentStream } = createClient(rounds);
		const { runtime, execute } = createRuntime();
		execute.mockResolvedValue({ courses: [] });

		const chunks = await collect(streamWithTools(client, buildRequest(), runtime, STARTED_AT));

		expect(generateContentStream).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1);
		expect(execute).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
		expect(generateContentStream.mock.calls[MAX_TOOL_ROUNDS]?.[0].config).not.toHaveProperty("tools");
		expect(doneOf(chunks).output_text).toBe("Resposta final");
	});

	it("should fall back to defaults when the stream carries no metadata", async () => {
		const { client } = createClient([[{} as GenerateContentResponse]]);
		const { runtime } = createRuntime();

		const response = doneOf(await collect(streamWithTools(client, buildRequest(), runtime, STARTED_AT)));

		expect(response).toMatchObject({
			messageId: "",
			model: "gemini-test",
			status: "UNKNOWN",
			output_text: "",
			thinking_output: undefined,
		});
		expect(response.tokens.total).toBe(0);
	});

	it("should throw before calling the model when the request was aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const { client, generateContentStream } = createClient([[chunk([{ text: "x" }])]]);
		const { runtime } = createRuntime();

		await expect(
			collect(
				streamWithTools(
					client,
					buildRequest({ config: { abortSignal: controller.signal } }),
					runtime,
					STARTED_AT,
				),
			),
		).rejects.toThrow();
		expect(generateContentStream).not.toHaveBeenCalled();
	});

	it("should propagate the error when the model call fails", async () => {
		const generateContentStream = vi.fn(async () => {
			throw new Error("quota");
		});
		const { runtime } = createRuntime();

		await expect(
			collect(
				streamWithTools(
					{ models: { generateContentStream } } as unknown as GeminiStreamClient,
					buildRequest(),
					runtime,
					STARTED_AT,
				),
			),
		).rejects.toThrow("quota");
	});
});
