import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { EventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, AssistantMessageEvent, SimpleStreamOptions } from "@earendil-works/pi-ai";

import {
	getRequestAuthError,
	rankModelCandidates,
	resolveAuthenticatedModelCandidate,
} from "../index.js";
import {
	clampTaskForDisplay,
	createSettleController,
	createSubagentRequestOptions,
	decideResume,
	formatAgentBadge,
	runSubagent,
} from "../lib/subagent-core.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => event.type === "done" ? event.message : event.error,
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 3,
			output: 2,
			cacheRead: 1,
			cacheWrite: 0,
			totalTokens: 6,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const TEST_MODEL = {
	provider: "test-provider",
	id: "test-model",
	name: "Test Model",
	api: "test-api",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

describe("runSubagent", () => {
	test("test_child_session_persists_lineage_resources_metadata_and_request_auth", async () => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const testRoot = mkdtempSync(join(tmpdir(), "btw-test-"));
		const agentDir = join(testRoot, "agent");
		const cwd = join(testRoot, "project");
		mkdirSync(cwd, { recursive: true });
		await Bun.write(join(cwd, "AGENTS.md"), "CHILD_RESOURCE_MARKER\n");
		process.env.PI_CODING_AGENT_DIR = agentDir;

		let receivedContext: { systemPrompt?: string } | undefined;
		let receivedOptions: SimpleStreamOptions | undefined;
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		(runtime as any).streamSimple = (
			_model: unknown,
			context: { systemPrompt?: string },
			options?: SimpleStreamOptions,
		) => {
			receivedContext = context;
			receivedOptions = options;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("OK") });
			});
			return stream;
		};

		try {
			const result = await runSubagent({
				cwd,
				modelRegistry: { runtime },
				model: TEST_MODEL,
				thinkingLevel: "off",
				task: "task",
				auth: {
					apiKey: "oauth-access-token",
					env: { AUTH_SCOPE: "captured" },
					headers: { Authorization: "Bearer captured" },
				},
				parentSessionFile: "/sessions/parent.jsonl",
				onProgress: () => {},
			});

			expect(result.errorMessage).toBeUndefined();
			expect(result.exitCode).toBe(0);
			expect(result.finalOutput).toBe("OK");
			expect(result.sessionId).toBeTruthy();
			expect(result.sessionFile).toBeTruthy();
			expect(existsSync(result.sessionFile!)).toBe(true);
			expect(receivedOptions).toMatchObject({
				apiKey: "oauth-access-token",
				env: { AUTH_SCOPE: "captured" },
				headers: { Authorization: "Bearer captured" },
				sessionId: result.sessionId,
			});
			expect(receivedContext?.systemPrompt).toContain("CHILD_RESOURCE_MARKER");
			const header = JSON.parse(readFileSync(result.sessionFile!, "utf8").split("\n")[0]);
			expect(header.parentSession).toBe("/sessions/parent.jsonl");
			expect(result.usage).toMatchObject({ input: 3, output: 2, cacheRead: 1, turns: 1 });
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	test("test_aborted_before_start_returns_without_creating_a_session", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runSubagent({
			cwd: process.cwd(),
			modelRegistry: {},
			model: TEST_MODEL,
			thinkingLevel: "off",
			task: "task",
			auth: {},
			signal: controller.signal,
			onProgress: () => {},
		});
		expect(result).toMatchObject({ exitCode: 1, stopReason: "aborted", errorMessage: "aborted before start" });
		expect(result.sessionId).toBeUndefined();
	});
});

describe("completion helpers", () => {
	test("test_settle_controller_waits_for_pending_retry_continuation", async () => {
		let busy = false;
		const controller = createSettleController({ isBusy: () => busy, settleMs: 5, graceMs: 30 });
		controller.onEvent({ type: "compaction_end", willRetry: true });
		let settled = false;
		void controller.done.then(() => {
			settled = true;
		});
		await Bun.sleep(10);
		expect(settled).toBe(false);
		busy = true;
		controller.onEvent({ type: "message_start" });
		await Bun.sleep(10);
		expect(settled).toBe(false);
		busy = false;
		controller.kick();
		await controller.done;
		expect(settled).toBe(true);
		controller.dispose();
	});

	test("test_resume_decision_nudges_then_surfaces_compaction_summary", () => {
		const lastCompaction = { willRetry: false, reason: "threshold", aborted: false, summary: "progress" };
		expect(decideResume({ finalText: "", lastCompaction, nudges: 0, maxNudges: 1 })).toEqual({ action: "nudge" });
		expect(decideResume({ finalText: "", lastCompaction, nudges: 1, maxNudges: 1 })).toEqual({
			action: "fallback",
			output: "progress",
		});
	});
});

describe("display helpers", () => {
	test("test_task_clamp_counts_omission_marker_within_limit", () => {
		expect(clampTaskForDisplay("one\ntwo\nthree\nfour", 3)).toBe("one\ntwo\n… +2 more lines");
	});

	test("test_agent_badge_distinguishes_applied_and_unresolved_overrides", () => {
		expect(formatAgentBadge({ mode: "deep", model: "provider/model", unresolved: ["mode:missing"] })).toBe(
			"deep provider/model ⚠ ignored mode:missing",
		);
	});
});

describe("createSubagentRequestOptions", () => {
	test("test_request_options_use_child_session_and_merge_auth_context", () => {
		const options = createSubagentRequestOptions(
			{
				apiKey: "oauth-access-token",
				env: { PROVIDER_SCOPE: "auth", SHARED: "auth" },
				headers: { Authorization: "Bearer token", Shared: "auth" },
			},
			"child-session-id",
			{
				env: { TURN_SCOPE: "turn", SHARED: "turn" },
				headers: { Shared: "turn" },
				sessionId: "runtime-session-id",
			},
		);
		expect(options).toMatchObject({
			apiKey: "oauth-access-token",
			env: { PROVIDER_SCOPE: "auth", TURN_SCOPE: "turn", SHARED: "turn" },
			headers: { Authorization: "Bearer token", Shared: "turn" },
			sessionId: "runtime-session-id",
		});
	});
});

describe("scoped model resolution", () => {
	const candidates = [
		{ model: { provider: "preferred", id: "alpha-model", name: "Alpha" } },
		{ model: { provider: "other", id: "alpha-model", name: "Alpha" } },
	];

	test("test_unqualified_fuzzy_match_biases_current_provider", () => {
		expect(rankModelCandidates("alpha", candidates, { preferredProvider: "preferred" })[0].model.provider).toBe(
			"preferred",
		);
	});

	test("test_explicit_provider_never_matches_a_different_provider", () => {
		expect(rankModelCandidates("other/alpha", candidates, { preferredProvider: "preferred" })).toEqual([
			candidates[1],
		]);
	});

	test("test_ranked_candidates_are_tried_until_request_auth_is_usable", async () => {
		const attemptedProviders: string[] = [];
		const matched = await resolveAuthenticatedModelCandidate(
			"alpha",
			candidates,
			{
				async getApiKeyAndHeaders(model) {
					attemptedProviders.push(model.provider);
					return model.provider === "preferred"
						? { ok: false as const, error: "expired" }
						: { ok: true as const, apiKey: "usable" };
				},
			},
			"preferred",
		);
		expect(attemptedProviders).toEqual(["preferred", "other"]);
		expect(matched.ok).toBe(true);
		if (!matched.ok) throw new Error(matched.error);
		expect(matched.candidate).toBe(candidates[1]);
		expect(matched.auth.apiKey).toBe("usable");
	});

	test("test_failed_codex_candidate_preserves_reauthentication_error", async () => {
		const matched = await resolveAuthenticatedModelCandidate(
			"gpt-5",
			[{ model: { provider: "openai-codex", id: "gpt-5" } }],
			{ async getApiKeyAndHeaders() { return { ok: true as const }; } },
			"openai-codex",
		);
		expect(matched).toMatchObject({ ok: false });
		if (matched.ok) throw new Error("Expected authentication failure");
		expect(matched.error).toContain("/login openai-codex");
	});
});

describe("getRequestAuthError", () => {
	test("test_openai_codex_without_oauth_token_returns_reauthentication_error", () => {
		expect(getRequestAuthError({ provider: "openai-codex" }, { ok: true })).toContain("/login openai-codex");
	});

	test("test_openai_codex_with_oauth_token_has_no_error", () => {
		expect(getRequestAuthError(
			{ provider: "openai-codex" },
			{ ok: true, apiKey: "oauth-access-token" },
		)).toBeUndefined();
	});

	test("test_registry_auth_failure_preserves_original_error", () => {
		expect(getRequestAuthError(
			{ provider: "anthropic" },
			{ ok: false, error: "credential store unavailable" },
		)).toBe("credential store unavailable");
	});

	test("test_provider_without_request_credentials_has_no_error", () => {
		expect(getRequestAuthError({ provider: "local" }, { ok: true })).toBeUndefined();
	});
});
