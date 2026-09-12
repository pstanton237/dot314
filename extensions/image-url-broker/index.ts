import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { streamSimple as streamSimpleByApi } from "@earendil-works/pi-ai/compat";

import {
	createContentAddressedImagePublisher,
	createImageBlob,
	isSupportedImageMimeType,
	loadImageUrlBrokerConfig,
	type ImageBlob,
	type ImagePublisher,
} from "./publication.ts";
import { createCodexImageFallback, unwrapCodexImageFallback } from "./stream-fallback.ts";

export interface ProviderModelHint {
	readonly provider: string;
	readonly api: string;
	readonly baseUrl: string;
	readonly input: readonly ("text" | "image")[];
}

export interface ImageUrlBrokerRegistrationOptions {
	readonly configPath?: string;
	readonly streamByApi?: NonNullable<ProviderConfig["streamSimple"]>;
}

type PayloadRecord = Record<string, unknown>;
type SupportedPayloadDialect = "anthropic" | "openai-chat" | "openai-responses";

interface CollectedImages {
	readonly imagesByKey: Map<string, ImageBlob>;
	readonly keyByOccurrence: WeakMap<object, string>;
}

function isRecord(value: unknown): value is PayloadRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(dialect: SupportedPayloadDialect, problem: string): Error {
	return new Error(`image-url-broker: malformed ${dialect} image payload: ${problem}`);
}

function diagnosticMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function visitContent(value: unknown, visitor: (record: PayloadRecord) => void): void {
	if (Array.isArray(value)) {
		for (const item of value) visitContent(item, visitor);
		return;
	}
	if (!isRecord(value)) return;
	visitor(value);
	if ("content" in value) visitContent(value.content, visitor);
	if ("output" in value) visitContent(value.output, visitor);
}

function visitMessagesContent(payload: PayloadRecord, visitor: (record: PayloadRecord) => void): void {
	if (!Array.isArray(payload.messages)) return;
	for (const message of payload.messages) {
		if (isRecord(message) && "content" in message) visitContent(message.content, visitor);
	}
}

function isAnthropicMarker(record: PayloadRecord): boolean {
	return record.type === "image" && isRecord(record.source) && record.source.type === "base64";
}

function isOpenAIChatMarker(record: PayloadRecord): boolean {
	return (
		record.type === "image_url" &&
		isRecord(record.image_url) &&
		typeof record.image_url.url === "string" &&
		record.image_url.url.startsWith("data:")
	);
}

function isOpenAIResponsesMarker(record: PayloadRecord): boolean {
	return record.type === "input_image" && typeof record.image_url === "string" && record.image_url.startsWith("data:");
}

function detectPayloadDialect(payload: PayloadRecord): SupportedPayloadDialect | undefined {
	const dialects = new Set<SupportedPayloadDialect>();
	visitMessagesContent(payload, record => {
		if (isAnthropicMarker(record)) dialects.add("anthropic");
		if (isOpenAIChatMarker(record)) dialects.add("openai-chat");
		if (isOpenAIResponsesMarker(record)) dialects.add("openai-responses");
	});
	if ("input" in payload) {
		visitContent(payload.input, record => {
			if (isAnthropicMarker(record)) dialects.add("anthropic");
			if (isOpenAIChatMarker(record)) dialects.add("openai-chat");
			if (isOpenAIResponsesMarker(record)) dialects.add("openai-responses");
		});
	}

	if (dialects.size === 0) return undefined;
	if (dialects.size > 1) {
		throw new Error(`image-url-broker: ambiguous image payload dialects: ${[...dialects].sort().join(", ")}`);
	}
	return dialects.values().next().value;
}

function modelAllowsDialect(model: ProviderModelHint | undefined, dialect: SupportedPayloadDialect): boolean {
	if (!model || !model.input.includes("image")) return false;
	switch (dialect) {
		case "anthropic":
			return (
				model.api === "anthropic-messages" &&
				model.provider === "anthropic" &&
				model.baseUrl === "https://api.anthropic.com"
			);
		case "openai-chat":
			return (
				model.api === "openai-completions" &&
				model.provider === "openai" &&
				model.baseUrl === "https://api.openai.com/v1"
			);
		case "openai-responses":
			return (
				(model.api === "openai-responses" &&
					model.provider === "openai" &&
					model.baseUrl === "https://api.openai.com/v1") ||
				(model.api === "openai-codex-responses" &&
					model.provider === "openai-codex" &&
					model.baseUrl === "https://chatgpt.com/backend-api")
			);
	}
}

function parseDataUrl(dataUrl: string, dialect: SupportedPayloadDialect): ImageBlob | undefined {
	const commaIndex = dataUrl.indexOf(",");
	const metadataEnd = commaIndex < 0 ? dataUrl.length : commaIndex;
	const metadata = dataUrl.slice("data:".length, metadataEnd);
	const semicolonIndex = metadata.indexOf(";");
	const mimeType = semicolonIndex < 0 ? metadata : metadata.slice(0, semicolonIndex);
	if (!isSupportedImageMimeType(mimeType)) return undefined;
	if (commaIndex < 0) throw errorMessage(dialect, "data URL is missing its comma separator");
	if (metadata !== `${mimeType};base64`) {
		throw errorMessage(dialect, "data URL metadata must be exactly <mimeType>;base64");
	}
	try {
		return createImageBlob(mimeType, dataUrl.slice(commaIndex + 1));
	} catch (error) {
		throw new Error(`image-url-broker: malformed ${dialect} image payload: invalid base64 data`, { cause: error });
	}
}

function parseAnthropicImage(record: PayloadRecord): ImageBlob | undefined {
	if (!isAnthropicMarker(record)) return undefined;
	const source = record.source as PayloadRecord;
	if (typeof source.media_type !== "string") throw errorMessage("anthropic", "media_type must be a string");
	if (!isSupportedImageMimeType(source.media_type)) return undefined;
	if (typeof source.data !== "string") throw errorMessage("anthropic", "data must be a string");
	try {
		return createImageBlob(source.media_type, source.data);
	} catch (error) {
		throw new Error("image-url-broker: malformed anthropic image payload: invalid base64 data", { cause: error });
	}
}

function parseOpenAIChatImage(record: PayloadRecord): ImageBlob | undefined {
	if (!isOpenAIChatMarker(record)) return undefined;
	const imageUrl = record.image_url as PayloadRecord;
	return parseDataUrl(imageUrl.url as string, "openai-chat");
}

function parseOpenAIResponsesImage(record: PayloadRecord): ImageBlob | undefined {
	if (!isOpenAIResponsesMarker(record)) return undefined;
	return parseDataUrl(record.image_url as string, "openai-responses");
}

function collectImages(payload: PayloadRecord, dialect: SupportedPayloadDialect): CollectedImages {
	const imagesByKey = new Map<string, ImageBlob>();
	const keyByOccurrence = new WeakMap<object, string>();
	const collect = (record: PayloadRecord): void => {
		const image =
			dialect === "anthropic"
				? parseAnthropicImage(record)
				: dialect === "openai-chat"
					? parseOpenAIChatImage(record)
					: parseOpenAIResponsesImage(record);
		if (!image) return;
		imagesByKey.set(image.key, image);
		keyByOccurrence.set(record, image.key);
	};

	if (dialect === "openai-responses") {
		if ("input" in payload) visitContent(payload.input, collect);
	} else {
		visitMessagesContent(payload, collect);
	}
	return { imagesByKey, keyByOccurrence };
}

function replaceImageRecord(
	record: PayloadRecord,
	dialect: SupportedPayloadDialect,
	keyByOccurrence: WeakMap<object, string>,
	urlByKey: ReadonlyMap<string, string>,
): PayloadRecord | undefined {
	const key = keyByOccurrence.get(record);
	if (!key) return undefined;
	const url = urlByKey.get(key);
	if (!url) throw new Error(`image-url-broker: missing publication URL for image ${key}`);

	if (dialect === "anthropic") return { ...record, source: { type: "url", url } };
	if (dialect === "openai-chat") {
		return { ...record, image_url: { ...(record.image_url as PayloadRecord), url } };
	}
	return { ...record, image_url: url };
}

function mapContent(
	value: unknown,
	dialect: SupportedPayloadDialect,
	keyByOccurrence: WeakMap<object, string>,
	urlByKey: ReadonlyMap<string, string>,
): unknown {
	if (Array.isArray(value)) {
		const mapped = value.map(item => mapContent(item, dialect, keyByOccurrence, urlByKey));
		return mapped.some((item, index) => item !== value[index]) ? mapped : value;
	}
	if (!isRecord(value)) return value;
	const replacement = replaceImageRecord(value, dialect, keyByOccurrence, urlByKey);
	if (replacement) return replacement;

	let mapped = value;
	for (const field of ["content", "output"] as const) {
		if (!(field in value)) continue;
		const next = mapContent(value[field], dialect, keyByOccurrence, urlByKey);
		if (next !== value[field]) mapped = { ...mapped, [field]: next };
	}
	return mapped;
}

function mapPayload(
	payload: PayloadRecord,
	dialect: SupportedPayloadDialect,
	keyByOccurrence: WeakMap<object, string>,
	urlByKey: ReadonlyMap<string, string>,
): PayloadRecord {
	if (dialect === "openai-responses") {
		const input = mapContent(payload.input, dialect, keyByOccurrence, urlByKey);
		return input === payload.input ? payload : { ...payload, input };
	}
	if (!Array.isArray(payload.messages)) return payload;
	const messages = payload.messages.map(message => {
		if (!isRecord(message) || !("content" in message)) return message;
		const content = mapContent(message.content, dialect, keyByOccurrence, urlByKey);
		return content === message.content ? message : { ...message, content };
	});
	return messages.some((message, index) => message !== payload.messages[index])
		? { ...payload, messages }
		: payload;
}

export async function rewriteSupportedImagePayload(
	payload: unknown,
	model: ProviderModelHint | undefined,
	publisher: ImagePublisher,
	signal?: AbortSignal,
): Promise<unknown | undefined> {
	if (signal?.aborted || !isRecord(payload)) return undefined;
	const dialect = detectPayloadDialect(payload);
	if (!dialect || !modelAllowsDialect(model, dialect)) return undefined;

	const { imagesByKey, keyByOccurrence } = collectImages(payload, dialect);
	if (imagesByKey.size === 0) return undefined;
	const urlByKey = new Map<string, string>();
	for (const [key, image] of imagesByKey) {
		urlByKey.set(key, await publisher.publish(image));
	}
	if (signal?.aborted) return undefined;

	const rewritten = mapPayload(payload, dialect, keyByOccurrence, urlByKey);
	return rewritten === payload ? undefined : rewritten;
}

export function registerImageUrlBrokerExtension(
	pi: ExtensionAPI,
	options: ImageUrlBrokerRegistrationOptions = {},
): void {
	const config = loadImageUrlBrokerConfig(options.configPath);
	if (!config) return;
	const publisher = createContentAddressedImagePublisher(config);
	const genericApiStream = options.streamByApi ?? streamSimpleByApi;
	let previousCodexConfig: ProviderConfig | undefined;
	let installedCodexStream: ProviderConfig["streamSimple"] | undefined;
	pi.on("before_provider_request", async (event, ctx) => {
		const isCodex = ctx.model?.provider === "openai-codex" && ctx.model.api === "openai-codex-responses";
		// Codex rewriting belongs to the retry-capable stream wrapper below
		return isCodex
			? undefined
			: rewriteSupportedImagePayload(event.payload, ctx.model, publisher, ctx.signal);
	});
	pi.on("session_start", (_event, ctx) => {
		if (ctx.modelRegistry.getRegisteredNativeProvider("openai-codex")) {
			console.warn("image-url-broker: OpenAI Codex native extension provider remains inline");
			return;
		}
		const registeredConfig = ctx.modelRegistry.getRegisteredProviderConfig("openai-codex");
		if (registeredConfig?.api && registeredConfig.api !== "openai-codex-responses") {
			console.warn(`image-url-broker: OpenAI Codex provider API ${registeredConfig.api} remains inline`);
			return;
		}
		previousCodexConfig = registeredConfig ? { ...registeredConfig } : undefined;
		const registeredStream =
			registeredConfig?.api === "openai-codex-responses" ? registeredConfig.streamSimple : undefined;
		const effectiveProvider = ctx.modelRegistry.getProvider("openai-codex");
		const effectiveProviderStream = effectiveProvider?.streamSimple.bind(effectiveProvider);
		if (!effectiveProviderStream) throw new Error("image-url-broker: OpenAI Codex provider is unavailable");
		// compat-ok: Provider config may omit streamSimple; unwrap only this extension's reload wrapper.
		const effectiveCodexStream = unwrapCodexImageFallback(registeredStream ?? effectiveProviderStream);
		const codexFallback = createCodexImageFallback(
			effectiveCodexStream,
			(payload, model, signal) => rewriteSupportedImagePayload(payload, model, publisher, signal),
			{
				rewriteFailed: error => {
					console.error(`image-url-broker: Codex URL publication failed; using inline image: ${diagnosticMessage(error)}`);
				},
				retryingInline: error => {
					console.warn(
						`image-url-broker: Codex URL attempt failed before content; retrying inline: ${error ?? "unknown error"}`,
					);
				},
			},
		);
		installedCodexStream = (model, context, streamOptions) =>
			model.api === "openai-codex-responses"
				? codexFallback.streamSimple(model, context, streamOptions)
				: genericApiStream(model, context, streamOptions);
		pi.registerProvider("openai-codex", {
			api: "openai-codex-responses",
			streamSimple: installedCodexStream,
		});
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (!installedCodexStream) return;
		const currentConfig = ctx.modelRegistry.getRegisteredProviderConfig("openai-codex");
		if (currentConfig?.streamSimple !== installedCodexStream) {
			installedCodexStream = undefined;
			previousCodexConfig = undefined;
			return;
		}

		const restoredConfig: ProviderConfig = { ...currentConfig };
		if (currentConfig.api === "openai-codex-responses") {
			if (previousCodexConfig?.api) restoredConfig.api = previousCodexConfig.api;
			else delete restoredConfig.api;
			if (previousCodexConfig?.streamSimple) restoredConfig.streamSimple = previousCodexConfig.streamSimple;
			else delete restoredConfig.streamSimple;
		} else {
			delete restoredConfig.streamSimple;
		}

		pi.unregisterProvider("openai-codex");
		if (Object.keys(restoredConfig).length > 0) pi.registerProvider("openai-codex", restoredConfig);
		installedCodexStream = undefined;
		previousCodexConfig = undefined;
	});
}

export default function imageUrlBrokerExtension(pi: ExtensionAPI): void {
	registerImageUrlBrokerExtension(pi);
}
