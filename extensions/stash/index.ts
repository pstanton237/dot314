import { readFileSync } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "prompt-stash";
const CONFIG_URL = new URL("./config.json", import.meta.url);

type Shortcut = Parameters<ExtensionAPI["registerShortcut"]>[0];

interface StashConfig {
	shortcut: Shortcut;
}

function loadConfig(): StashConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(CONFIG_URL, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read stash config at ${CONFIG_URL.pathname}: ${message}`);
	}

	if (
		typeof parsed !== "object"
		|| parsed === null
		|| Array.isArray(parsed)
		|| Object.keys(parsed).length !== 1
		|| typeof (parsed as Record<string, unknown>).shortcut !== "string"
	) {
		throw new Error(`Invalid stash config at ${CONFIG_URL.pathname}: expected { "shortcut": "<key>" }`);
	}

	return { shortcut: (parsed as { shortcut: string }).shortcut as Shortcut };
}

export default function stashExtension(pi: ExtensionAPI): void {
	const config = loadConfig();
	let stashedText: string | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_ID, stashedText === undefined ? undefined : "stash");
	}

	function toggleStash(ctx: ExtensionContext): void {
		const editorText = ctx.ui.getEditorText();

		if (stashedText === undefined) {
			if (editorText.length === 0) {
				ctx.ui.notify("Nothing to stash", "info");
				return;
			}

			stashedText = editorText;
			ctx.ui.setEditorText("");
			ctx.ui.notify("Prompt stashed", "info");
		} else {
			const restoredText = stashedText;
			stashedText = editorText.length === 0 ? undefined : editorText;
			ctx.ui.setEditorText(restoredText);
			ctx.ui.notify(editorText.length === 0 ? "Prompt restored" : "Prompts swapped", "info");
		}

		updateStatus(ctx);
	}

	pi.registerShortcut(config.shortcut, {
		description: "Stash, restore, or swap editor text",
		handler: toggleStash,
	});

	pi.on("session_start", (_event, ctx) => updateStatus(ctx));
}
