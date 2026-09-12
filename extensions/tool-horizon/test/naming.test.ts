import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
	TOOL_HORIZON_DISABLED_STATE,
	TOOL_HORIZON_STATE_CUSTOM_TYPE,
	TOOL_HORIZON_STATUS_KEY,
	formatContextTokenSavings,
	getToolHorizonRuntimeSnapshot,
	loadToolHorizonStateFromEntries,
	normalizeToolHorizonState,
	setToolHorizonRuntimeSnapshot,
} from "../core.ts";
import {
	TOOL_HORIZON_CHECKPOINT_MESSAGE_CUSTOM_TYPE,
	TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE,
	normalizeCheckpointState,
} from "../provenance.ts";

test("test_tool_horizon_uses_canonical_public_and_persistence_names", () => {
	expect(TOOL_HORIZON_STATE_CUSTOM_TYPE).toBe("tool-horizon-state");
	expect(TOOL_HORIZON_STATUS_KEY).toBe("tool-horizon");
	expect(TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE).toBe("tool-horizon-checkpoint-state");
	expect(TOOL_HORIZON_CHECKPOINT_MESSAGE_CUSTOM_TYPE).toBe("tool-horizon-checkpoint");
});

test("test_tool_horizon_rejects_former_state_schema", () => {
	const formerState = {
		enabled: true,
		anchorMode: "pending-here",
		anchorFingerprint: null,
	};

	expect(normalizeToolHorizonState(formerState)).toEqual({
		enabled: false,
		boundaryMode: null,
		boundaryFingerprint: null,
	});
});

test("test_tool_horizon_accepts_only_canonical_pending_state", () => {
	expect(normalizeToolHorizonState({
		enabled: true,
		boundaryMode: "pending",
		boundaryFingerprint: null,
	})).toEqual({
		enabled: true,
		boundaryMode: "pending",
		boundaryFingerprint: null,
	});
});

test("test_hybrid_state_with_former_fields_is_rejected", () => {
	const canonicalFingerprint = {
		role: "user",
		textPrefix: "hello",
		toolNames: null,
		toolCount: 0,
		payloadIndex: 0,
	};
	for (const hybridState of [
		{
			enabled: true,
			boundaryMode: "pending",
			boundaryFingerprint: null,
			anchorMode: "pending-here",
		},
		{
			enabled: true,
			boundaryMode: "from-entry",
			boundaryFingerprint: canonicalFingerprint,
			anchorFingerprint: canonicalFingerprint,
		},
	]) {
		expect(normalizeToolHorizonState(hybridState)).toEqual(TOOL_HORIZON_DISABLED_STATE);
	}
});

test("test_tool_horizon_rejects_noncanonical_pending_values", () => {
	for (const boundaryMode of ["pending-here", "here", null]) {
		expect(normalizeToolHorizonState({
			enabled: true,
			boundaryMode,
			boundaryFingerprint: null,
		})).toEqual(TOOL_HORIZON_DISABLED_STATE);
	}
});

test("test_tool_horizon_rejects_malformed_boundary_fingerprints", () => {
	const canonical = {
		role: "user",
		textPrefix: "hello",
		toolNames: null,
		toolCount: 0,
		payloadIndex: 1,
	};
	const invalidFingerprints = [
		{ role: "user", textPrefix: "hello" },
		{ ...canonical, toolNames: ["read", 42], toolCount: 2 },
		{ ...canonical, payloadIndex: -1 },
		{ ...canonical, payloadIndex: 1.5 },
		{ ...canonical, toolCount: 1 },
		{ ...canonical, textPrefix: null },
		{ ...canonical, textPrefix: " hello " },
		{ ...canonical, textPrefix: "hello  world" },
		{ ...canonical, textPrefix: "x".repeat(121) },
		{ ...canonical, toolNames: [] },
		{ ...canonical, anchorSignature: "former" },
		{ ...canonical, toolNames: ["write", "read"], toolCount: 2 },
	];
	for (const boundaryFingerprint of invalidFingerprints) {
		expect(normalizeToolHorizonState({
			enabled: true,
			boundaryMode: "from-entry",
			boundaryFingerprint,
		})).toEqual(TOOL_HORIZON_DISABLED_STATE);
	}
});

test("test_checkpoint_requires_canonical_boundary_fields_and_signature", () => {
	const files = { read: ["src/model.ts"], modified: [], created: [], deleted: [], moved: [] };
	expect(normalizeCheckpointState({
		version: 1,
		scope: "before-boundary",
		anchorMode: "from-entry",
		anchorSignature: "former",
		generatedAt: 0,
		files,
	})).toBeNull();
	expect(normalizeCheckpointState({
		version: 1,
		scope: "before-boundary",
		boundaryMode: "from-entry",
		boundarySignature: "",
		generatedAt: 0,
		files,
	})).toBeNull();
	expect(normalizeCheckpointState({
		version: 1,
		scope: "before-boundary",
		boundaryMode: "from-entry",
		boundarySignature: "current",
		generatedAt: 0,
		files,
	})?.boundarySignature).toBe("current");
});

test("test_context_token_savings_uses_unicode_minus_without_approximation", () => {
	expect(formatContextTokenSavings(0)).toBe("−0 context tokens");
	expect(formatContextTokenSavings(742)).toBe("−742 context tokens");
	expect(formatContextTokenSavings(12400)).toBe("−12.4k context tokens");
});

test("test_packaged_config_contains_only_canonical_keys", () => {
	const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf-8"));
	expect(config).toEqual({
		warnBeforeRestoreAllThresholdPercent: 70,
		restoreAllAfterCompaction: true,
	});
	const extensionSource = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");
	expect(extensionSource).not.toContain("warnBeforeOffThresholdPercent");
	expect(extensionSource).not.toContain("turnOffAfterCompaction");
	expect(extensionSource).not.toContain("DILIGENT_CONTEXT_DEBUG");
});

test("test_user_notifications_use_horizon_terminology", () => {
	const extensionSource = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");
	for (const retiredCopy of [
		"boundary changes require an idle agent",
		"checkpoint does not match its boundary",
		"boundary uses an unsupported persisted layout",
		"checkpoint rows cannot be used as pruning boundaries",
		"no boundary can be resolved",
		"boundary not set",
	]) {
		expect(extensionSource).not.toContain(retiredCopy);
	}
	expect(extensionSource).toContain("horizon changes require an idle agent");
	expect(extensionSource).toContain("this checkpoint entry cannot begin a horizon");
	expect(extensionSource).toContain("horizon not set");
});

test("test_former_custom_state_type_is_ignored", () => {
	const state = loadToolHorizonStateFromEntries([{
		type: "custom",
		customType: "diligent-context-state",
		data: {
			enabled: true,
			boundaryMode: "pending",
			boundaryFingerprint: null,
		},
	}], true);

	expect(state).toEqual(TOOL_HORIZON_DISABLED_STATE);
});

test("test_former_runtime_namespace_is_ignored", () => {
	setToolHorizonRuntimeSnapshot(null, null);
	const formerKey = Symbol.for("pi.extensions.diligent-context.runtime.v1");
	const globalStore = globalThis as typeof globalThis & Record<symbol, unknown>;
	globalStore[formerKey] = { sessionId: "session-a", snapshot: { state: "former" } };

	expect(getToolHorizonRuntimeSnapshot("session-a")).toBeNull();
	delete globalStore[formerKey];
});

test("test_runtime_snapshot_is_scoped_to_the_canonical_session", () => {
	const snapshot = {
		state: TOOL_HORIZON_DISABLED_STATE,
		rawMessages: null,
		filteredMessages: null,
		filteredToRawIndices: [],
		resolvedBoundaryIndex: null,
	};
	setToolHorizonRuntimeSnapshot("session-a", snapshot);

	expect(getToolHorizonRuntimeSnapshot("session-a")).toBe(snapshot);
	expect(getToolHorizonRuntimeSnapshot("session-b")).toBeNull();
	setToolHorizonRuntimeSnapshot(null, null);
	expect(getToolHorizonRuntimeSnapshot("session-a")).toBeNull();
});
