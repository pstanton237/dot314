/**
 * Shared mode/model resolution utilities.
 *
 * Used by /btw to resolve --mode and --model parameters against modes.json.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export type ModeSpec = {
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
};

/**
 * Load a mode spec from modes.json by name.
 * Checks project-level .pi/modes.json first, then global ~/.pi/agent/modes.json.
 * Returns the spec if found, or undefined.
 */
export async function loadModeSpec(
	cwd: string,
	modeName: string,
): Promise<ModeSpec | undefined> {
	const expandUser = (p: string) => {
		if (p === "~") return os.homedir();
		if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
		return p;
	};

	const agentDir = process.env.PI_CODING_AGENT_DIR
		? expandUser(process.env.PI_CODING_AGENT_DIR)
		: path.join(os.homedir(), ".pi", "agent");

	const candidates = [
		path.join(cwd, ".pi", "modes.json"),
		path.join(agentDir, "modes.json"),
	];

	for (const modesPath of candidates) {
		try {
			const raw = fs.readFileSync(modesPath, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed.modes && typeof parsed.modes === "object" && parsed.modes[modeName]) {
				const spec = parsed.modes[modeName];
				return {
					provider: typeof spec.provider === "string" ? spec.provider : undefined,
					modelId: typeof spec.modelId === "string" ? spec.modelId : undefined,
					thinkingLevel: typeof spec.thinkingLevel === "string" ? spec.thinkingLevel : undefined,
				};
			}
		} catch {
			continue;
		}
	}
	return undefined;
}

export interface ResolvedModeAndThinking {
	model: any;
	thinkingLevel: string;
	applied: { mode?: string; model?: string };
	unresolved: string[];
}

/**
 * Resolve a target model and thinking level from mode/model parameters.
 * Returns the resolved model and thinking level, using defaults from the
 * current context if not overridden, plus the applied and unresolved requests.
 */
export async function resolveModelAndThinking(
	cwd: string,
	modelRegistry: any,
	currentModel: any,
	currentThinkingLevel: string,
	params: { mode?: string; model?: string },
): Promise<ResolvedModeAndThinking> {
	let targetModel = currentModel;
	let targetThinkingLevel = currentThinkingLevel;
	const applied: { mode?: string; model?: string } = {};
	const unresolved: string[] = [];

	if (params.mode) {
		const spec = await loadModeSpec(cwd, params.mode);
		let modeApplied = false;
		if (spec) {
			if (spec.provider && spec.modelId) {
				const model = modelRegistry.find(spec.provider, spec.modelId);
				if (model) {
					targetModel = model;
					modeApplied = true;
				}
			}
			if (spec.thinkingLevel) {
				targetThinkingLevel = spec.thinkingLevel;
				modeApplied = true;
			}
		}
		if (modeApplied) applied.mode = params.mode;
		else unresolved.push(`mode:${params.mode}`);
	}

	if (params.model) {
		const slashIndex = params.model.indexOf("/");
		const model = slashIndex > 0
			? modelRegistry.find(params.model.slice(0, slashIndex), params.model.slice(slashIndex + 1))
			: undefined;
		if (model) {
			targetModel = model;
			applied.model = params.model;
		} else {
			unresolved.push(`model:${params.model}`);
		}
	}

	return { model: targetModel, thinkingLevel: targetThinkingLevel, applied, unresolved };
}
