import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export type SupportedImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface ImageBlob {
	readonly key: string;
	readonly mimeType: SupportedImageMimeType;
	readonly base64: string;
}

export interface ImagePublisher {
	publish(image: ImageBlob): Promise<string>;
}

export interface ImageUrlBrokerConfig {
	readonly publicBaseUrl: string;
	readonly outputDirectory: string;
}

const SUFFIX_BY_MIME_TYPE: Readonly<Record<SupportedImageMimeType, string>> = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

const STANDARD_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CONFIG_FIELDS = new Set(["publicBaseUrl", "outputDirectory"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function defaultConfigPath(): string {
	return fileURLToPath(new URL("./config.json", import.meta.url));
}

export function isSupportedImageMimeType(mimeType: string): mimeType is SupportedImageMimeType {
	return Object.hasOwn(SUFFIX_BY_MIME_TYPE, mimeType);
}

function hasCanonicalPaddingBits(base64: string): boolean {
	if (base64.endsWith("==")) {
		return (BASE64_ALPHABET.indexOf(base64[base64.length - 3]) & 0b1111) === 0;
	}
	if (base64.endsWith("=")) {
		return (BASE64_ALPHABET.indexOf(base64[base64.length - 2]) & 0b11) === 0;
	}
	return true;
}

function validateCanonicalBase64(base64: string): void {
	if (
		base64.length === 0 ||
		base64.length % 4 !== 0 ||
		!STANDARD_BASE64_PATTERN.test(base64) ||
		!hasCanonicalPaddingBits(base64)
	) {
		throw new Error("image-url-broker: image data must be non-empty canonical padded base64");
	}
}

export function createImageBlob(mimeType: string, base64: string): ImageBlob | undefined {
	if (!isSupportedImageMimeType(mimeType)) return undefined;
	validateCanonicalBase64(base64);
	const key = createHash("sha256").update(mimeType).update("\n").update(base64).digest("hex");
	return { key, mimeType, base64 };
}

function parsePublicBaseUrl(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error("publicBaseUrl must be a non-empty string");
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new Error(`publicBaseUrl must be an absolute URL: ${errorMessage(error)}`);
	}

	if (url.protocol !== "https:") throw new Error("publicBaseUrl must use https");
	if (!url.host) throw new Error("publicBaseUrl must include a host");
	if (url.username || url.password) throw new Error("publicBaseUrl must not include credentials");
	if (url.search) throw new Error("publicBaseUrl must not include a query");
	if (url.hash) throw new Error("publicBaseUrl must not include a fragment");
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	return url.toString();
}

function parseOutputDirectory(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error("outputDirectory must be a non-empty string");
	}
	if (!isAbsolute(value)) throw new Error("outputDirectory must be an absolute path");
	return normalize(value);
}

function validateConfig(rawConfig: unknown): ImageUrlBrokerConfig {
	if (!isRecord(rawConfig)) throw new Error("config root must be an object");
	for (const field of Object.keys(rawConfig)) {
		if (!CONFIG_FIELDS.has(field)) throw new Error(`unsupported field: ${field}`);
	}
	if (!("publicBaseUrl" in rawConfig)) throw new Error("missing required field: publicBaseUrl");
	if (!("outputDirectory" in rawConfig)) throw new Error("missing required field: outputDirectory");
	return {
		publicBaseUrl: parsePublicBaseUrl(rawConfig.publicBaseUrl),
		outputDirectory: parseOutputDirectory(rawConfig.outputDirectory),
	};
}

export function loadImageUrlBrokerConfig(
	configPath: string = defaultConfigPath(),
): ImageUrlBrokerConfig | undefined {
	let contents: string;
	try {
		contents = readFileSync(configPath, "utf8");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return undefined;
		throw new Error(`image-url-broker: failed to read config at ${configPath}: ${errorMessage(error)}`, {
			cause: error,
		});
	}

	let rawConfig: unknown;
	try {
		rawConfig = JSON.parse(contents);
	} catch (error) {
		throw new Error(`image-url-broker: failed to parse config at ${configPath}: ${errorMessage(error)}`, {
			cause: error,
		});
	}

	try {
		return validateConfig(rawConfig);
	} catch (error) {
		throw new Error(`image-url-broker: invalid config at ${configPath}: ${errorMessage(error)}`, {
			cause: error,
		});
	}
}

function initializeOutputDirectory(outputDirectory: string): void {
	const probeId = randomUUID();
	const probePath = join(outputDirectory, `.probe-${probeId}`);
	const renamedProbePath = join(outputDirectory, `.probe-${probeId}-renamed`);
	try {
		mkdirSync(outputDirectory, { recursive: true });
		if (!statSync(outputDirectory).isDirectory()) {
			throw new Error("path does not resolve to a directory");
		}
		try {
			writeFileSync(probePath, "", { flag: "wx", mode: 0o600 });
			renameSync(probePath, renamedProbePath);
			unlinkSync(renamedProbePath);
		} finally {
			for (const path of [probePath, renamedProbePath]) {
				try {
					unlinkSync(path);
				} catch {
					// Best-effort cleanup must not mask the capability-probe outcome
				}
			}
		}
	} catch (error) {
		throw new Error(
			`image-url-broker: failed to initialize output directory at ${outputDirectory}: ${errorMessage(error)}`,
			{ cause: error },
		);
	}
}

function publicationError(
	operation: string,
	image: ImageBlob,
	path: string,
	error: unknown,
): Error {
	return new Error(
		`image-url-broker: failed to ${operation} image ${image.key} (${image.mimeType}) at ${path}: ${errorMessage(error)}`,
		{ cause: error },
	);
}

async function existingRegularFile(path: string, image: ImageBlob): Promise<boolean> {
	try {
		const entry = await lstat(path);
		if (!entry.isFile()) throw new Error("existing path is not a regular file");
		return true;
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return false;
		throw publicationError("inspect publication path for", image, path, error);
	}
}

async function publishOnce(
	image: ImageBlob,
	outputDirectory: string,
	publicBaseUrl: string,
): Promise<string> {
	const filename = `${image.key}${SUFFIX_BY_MIME_TYPE[image.mimeType]}`;
	const finalPath = join(outputDirectory, filename);
	const publicUrl = new URL(filename, publicBaseUrl).toString();
	if (await existingRegularFile(finalPath, image)) return publicUrl;

	const temporaryPath = join(outputDirectory, `.tmp-${image.key}-${randomUUID()}`);
	try {
		try {
			await writeFile(temporaryPath, Buffer.from(image.base64, "base64"), { flag: "wx", mode: 0o644 });
		} catch (error) {
			throw publicationError("write temporary file for", image, temporaryPath, error);
		}

		try {
			await rename(temporaryPath, finalPath);
		} catch (error) {
			if (!(await existingRegularFile(finalPath, image))) {
				throw publicationError("publish", image, finalPath, error);
			}
		}
		return publicUrl;
	} finally {
		try {
			await unlink(temporaryPath);
		} catch {
			// Best-effort cleanup must not mask the publication outcome
		}
	}
}

export function createContentAddressedImagePublisher(config: ImageUrlBrokerConfig): ImagePublisher {
	initializeOutputDirectory(config.outputDirectory);
	const inFlightByKey = new Map<string, Promise<string>>();

	return {
		publish(image) {
			const existing = inFlightByKey.get(image.key);
			if (existing) return existing;
			const pending = publishOnce(image, config.outputDirectory, config.publicBaseUrl).finally(() => {
				inFlightByKey.delete(image.key);
			});
			inFlightByKey.set(image.key, pending);
			return pending;
		},
	};
}
