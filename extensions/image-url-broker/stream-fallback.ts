import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Api,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
} from "@earendil-works/pi-ai";

type CodexStream = StreamFunction<"openai-codex-responses", SimpleStreamOptions>;
type ImageSource = "url" | "inline";
const CODEX_BASE_STREAM = Symbol.for("image-url-broker.codex-base-stream");

type MarkedCodexStream = CodexStream & {
	readonly [CODEX_BASE_STREAM]?: CodexStream;
};

interface ImageAttempt {
	readonly source: ImageSource;
	payloadRewritten: boolean;
}

export type CodexPayloadRewriter = (
	payload: unknown,
	model: Model<Api>,
	signal?: AbortSignal,
) => Promise<unknown | undefined>;

export interface CodexImageFallback {
	readonly streamSimple: CodexStream;
	isQuarantined(): boolean;
}

export interface CodexFallbackReporter {
	rewriteFailed(error: unknown): void;
	retryingInline(errorMessage: string | undefined): void;
}

const NOOP_REPORTER: CodexFallbackReporter = {
	rewriteFailed() {},
	retryingInline() {},
};

export function unwrapCodexImageFallback(stream: CodexStream): CodexStream {
	return (stream as MarkedCodexStream)[CODEX_BASE_STREAM] ?? stream;
}

function failureMessage(
	model: Model<"openai-codex-responses">,
	error: unknown,
	aborted: boolean,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function isContentEvent(event: AssistantMessageEvent): boolean {
	return event.type !== "start" && event.type !== "done" && event.type !== "error";
}

export function createCodexImageFallback(
	baseStream: CodexStream,
	rewritePayload: CodexPayloadRewriter,
	reporter: CodexFallbackReporter = NOOP_REPORTER,
): CodexImageFallback {
	const effectiveBaseStream = unwrapCodexImageFallback(baseStream);
	let quarantined = false;

	const streamSimple: CodexStream = (model, context, options) => {
		const outer = createAssistantMessageEventStream();
		const startAttempt = (source: ImageSource): { attempt: ImageAttempt; stream: ReturnType<CodexStream> } => {
			const attempt: ImageAttempt = { source, payloadRewritten: false };
			const onPayload: SimpleStreamOptions["onPayload"] = async (payload, payloadModel) => {
				const chained = await options?.onPayload?.(payload, payloadModel);
				if (source === "inline") return chained;
				const currentPayload = chained === undefined ? payload : chained;
				let rewritten: unknown | undefined;
				try {
					rewritten = await rewritePayload(currentPayload, payloadModel, options?.signal);
				} catch (error) {
					reporter.rewriteFailed(error);
					return chained;
				}
				if (rewritten === undefined) return chained;
				attempt.payloadRewritten = true;
				return rewritten;
			};
			return { attempt, stream: effectiveBaseStream(model, context, { ...options, onPayload }) };
		};

		const run = async (): Promise<void> => {
			const first = startAttempt(quarantined ? "inline" : "url");
			let sawStart = false;
			let contentExposed = false;
			let retryInline = false;

			for await (const event of first.stream) {
				if (event.type === "start") {
					if (!sawStart) {
						sawStart = true;
						outer.push(event);
					}
					continue;
				}
				if (
					!contentExposed &&
					event.type === "error" &&
					event.reason === "error" &&
					first.attempt.source === "url" &&
					first.attempt.payloadRewritten &&
					!options?.signal?.aborted
				) {
					reporter.retryingInline(event.error.errorMessage);
					retryInline = true;
					break;
				}

				if (isContentEvent(event)) contentExposed = true;
				outer.push(event);
			}

			if (!retryInline) return;
			const inline = startAttempt("inline");
			for await (const event of inline.stream) {
				if (event.type === "start") {
					if (!sawStart) {
						sawStart = true;
						outer.push(event);
					}
					continue;
				}
				outer.push(event);
				if (event.type === "done") quarantined = true;
			}
		};

		void run().catch(error => {
			const aborted = options?.signal?.aborted ?? false;
			const message = failureMessage(model, error, aborted);
			outer.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
		});
		return outer;
	};
	Object.defineProperty(streamSimple, CODEX_BASE_STREAM, { value: effectiveBaseStream });

	return {
		streamSimple,
		isQuarantined: () => quarantined,
	};
}
