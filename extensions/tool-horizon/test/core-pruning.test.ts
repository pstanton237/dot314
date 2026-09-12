import assert from "node:assert/strict";
import test from "node:test";

import {
	applyPruningAtBoundary,
	computeBoundarySafeRawIndices,
	computeBoundaryFingerprint,
	normalizeToolHorizonState,
	resolveBoundaryIndex,
	type EventMessage,
} from "../core.ts";

function user(text: string): EventMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): EventMessage {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolCall(id: string, name = "read"): EventMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: { path: `/tmp/${id}` } }] };
}

function assistantThinkingToolCall(id: string, thinking: string, name = "read"): EventMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking },
			{ type: "toolCall", id, name, arguments: { path: `/tmp/${id}` } },
		],
	};
}

function toolResult(id: string, text: string): EventMessage {
	return { role: "toolResult", toolCallId: id, content: [{ type: "text", text }] };
}

test("test_apply_pruning_keeps_already_empty_assistant_message", () => {
	const emptyAssistant: EventMessage = { role: "assistant", content: [] };
	const messages = [user("hello"), emptyAssistant, user("second")];
	const result = applyPruningAtBoundary(messages, 2, "from-entry");

	assert.equal(result.filteredMessages.length, 3, "already-empty assistant must survive pruning");
	assert.equal(result.filteredMessages[1], emptyAssistant, "and must be kept by reference");
	assert.equal(result.changed, false, "an untouched payload must not report changes");
});

test("test_apply_pruning_still_drops_assistant_emptied_by_pruning", () => {
	const messages = [assistantToolCall("t1"), toolResult("t1", "body"), user("after")];
	const result = applyPruningAtBoundary(messages, 2, "from-entry");

	assert.equal(result.changed, true);
	assert.deepEqual(
		result.filteredMessages.map((message) => message.role),
		["user"],
		"the tool-call assistant is emptied by pruning and therefore dropped, along with its result",
	);
});

test("test_apply_pruning_preserves_latest_thinking_message_invariant", () => {
	const protectedAssistant = assistantThinkingToolCall("t2", "reasoning");
	const messages = [
		assistantToolCall("t1"),
		toolResult("t1", "older body"),
		protectedAssistant,
		toolResult("t2", "protected body"),
	];
	const result = applyPruningAtBoundary(messages, 3, "from-entry");

	assert.ok(result.filteredMessages.includes(protectedAssistant), "protected assistant kept by reference");
	assert.ok(
		result.filteredMessages.some((message) => message.role === "toolResult" && message.toolCallId === "t2"),
		"protected tool result retained",
	);
	assert.equal(
		result.filteredMessages.some((message) => message.role === "toolResult" && message.toolCallId === "t1"),
		false,
		"unprotected older tool result pruned",
	);
});

test("test_apply_pruning_preserves_latest_redacted_thinking_message", () => {
	const protectedAssistant: EventMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "opaque", redacted: true },
			{ type: "toolCall", id: "t1", name: "read", arguments: {} },
		],
	};
	const protectedResult = toolResult("t1", "body");
	const result = applyPruningAtBoundary([protectedAssistant, protectedResult], 1, "from-entry");

	assert.equal(result.filteredMessages[0], protectedAssistant);
	assert.equal(result.filteredMessages[1], protectedResult);
});

test("test_apply_pruning_removes_signed_thinking_from_modified_historical_assistant", () => {
	const historicalAssistant: EventMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "I inspected the file" },
			{ type: "thinking", thinking: "signed reasoning" },
			{ type: "thinking", thinking: "opaque", redacted: true },
			{ type: "toolCall", id: "t1", name: "read", arguments: {} },
		],
	};
	const newestProtectedAssistant: EventMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "new opaque", redacted: true },
			{ type: "toolCall", id: "t2", name: "read", arguments: {} },
		],
	};
	const result = applyPruningAtBoundary([
		historicalAssistant,
		toolResult("t1", "old body"),
		newestProtectedAssistant,
		toolResult("t2", "new body"),
	], 3, "from-entry");
	const historicalAfterPruning = result.filteredMessages.find(
		(message) => message.role === "assistant" && message !== newestProtectedAssistant,
	);

	assert.deepEqual(historicalAfterPruning?.content, [{ type: "text", text: "I inspected the file" }]);
	assert.ok(result.filteredMessages.includes(newestProtectedAssistant));
	assert.ok(result.filteredMessages.some((message) => message.role === "toolResult" && message.toolCallId === "t2"));
});

test("test_boundary_safe_indices_exclude_tool_results_with_in_payload_issuer", () => {
	const messages = [user("hi"), assistantToolCall("t1"), toolResult("t1", "body"), user("next")];
	const safe = computeBoundarySafeRawIndices(messages);

	assert.equal(safe.has(2), false, "a tool result answering an earlier call is not a legal boundary");
	assert.equal(safe.has(0), true);
	assert.equal(safe.has(3), true);
});

test("test_boundary_safe_indices_include_orphaned_tool_result", () => {
	// Issuer absent from the payload (compacted away): its id can never enter payloadPruneIds.
	const messages = [user("hi"), toolResult("orphan", "body"), user("next")];
	const safe = computeBoundarySafeRawIndices(messages);

	assert.equal(safe.has(1), true, "an orphaned tool result cannot be pruned, so it is a legal boundary");
});

test("test_boundary_safe_indices_exclude_index_inside_unclosed_tool_exchange", () => {
	const messages = [assistantToolCall("t1"), assistantText("interleaved"), toolResult("t1", "body"), user("after")];
	const safe = computeBoundarySafeRawIndices(messages);

	assert.equal(safe.has(1), false, "index 1 sits between a call and its result, so pruning would alter the suffix");
	assert.equal(safe.has(3), true);
});

test("test_after_entry_split_rejects_text_assistant_with_result_in_suffix", () => {
	const assistant: EventMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "I will edit that" },
			{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "src/model.ts" } },
		],
	};
	const messages = [user("please edit"), assistant, toolResult("t1", "ok")];
	const safe = computeBoundarySafeRawIndices(messages);

	assert.equal(safe.has(2), false, "the split after the assistant crosses its tool exchange");
});

test("test_boundary_safe_indices_are_independent_of_thinking_protection", () => {
	// Regression for a delayed-failure bug: validating a boundary by diffing applyPruningAtBoundary's
	// output classifies r1 as safe here, because getProtectedPruneContext shields the most recent
	// thinking-bearing assistant and its results. One turn later a newer thinking assistant takes over
	// protection and the same boundary deletes r1 -- the message the user chose to keep.
	const protectedAssistant = assistantThinkingToolCall("t1", "latest reasoning");
	const r1 = toolResult("t1", "first body");
	const messages = [user("hi"), protectedAssistant, r1, user("after")];
	const boundary = messages.indexOf(r1);

	const projection = applyPruningAtBoundary(messages, boundary, "from-entry");
	const changedAtOrAfterBoundary = projection.filteredMessages.length !== messages.length;
	assert.equal(changedAtOrAfterBoundary, false, "precondition: protection makes the projection look clean");

	const safe = computeBoundarySafeRawIndices(messages);
	assert.equal(safe.has(boundary), false, "structural safety must still reject the tool-result boundary");
});

test("test_compaction_summary_fingerprint_round_trips", () => {
	const messages: EventMessage[] = [
		{ role: "compactionSummary", summary: "a compacted conversation", tokensBefore: 100 },
		user("after compaction"),
	];
	const fingerprint = computeBoundaryFingerprint(messages[0], 0);

	assert.equal(fingerprint.textPrefix, "a compacted conversation");
	assert.equal(resolveBoundaryIndex(messages, fingerprint), 0);
});

test("test_branch_summary_fingerprint_round_trips", () => {
	const messages: EventMessage[] = [
		{ role: "branchSummary", summary: "a branch summary" },
		user("after branch summary"),
	];
	const fingerprint = computeBoundaryFingerprint(messages[0], 0);

	assert.equal(fingerprint.textPrefix, "a branch summary");
	assert.equal(resolveBoundaryIndex(messages, fingerprint), 0);
});

test("test_existing_fingerprints_still_round_trip", () => {
	const messages = [user("first"), assistantToolCall("t1"), toolResult("t1", "body"), assistantText("done")];
	for (const index of [0, 1, 3]) {
		const fingerprint = computeBoundaryFingerprint(messages[index], index);
		assert.equal(resolveBoundaryIndex(messages, fingerprint), index, `index ${index} must round-trip`);
	}
});

test("test_computed_fingerprint_survives_state_normalization_with_mixed_tool_names", () => {
	const assistant: EventMessage = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "t1", name: "Z-tool", arguments: {} },
			{ type: "toolCall", id: "t2", name: "a_tool", arguments: {} },
			{ type: "toolCall", id: "t3", name: "@lookup", arguments: {} },
		],
	};
	const messages = [user("start"), assistant];
	const persistedState = JSON.parse(JSON.stringify({
		enabled: true,
		boundaryMode: "from-entry",
		boundaryFingerprint: computeBoundaryFingerprint(assistant, 1),
	}));
	const normalized = normalizeToolHorizonState(persistedState);

	assert.equal(normalized.enabled, true);
	if (normalized.boundaryMode === "pending") throw new Error("expected resolved state");
	assert.equal(resolveBoundaryIndex(messages, normalized.boundaryFingerprint), 1);
});

test("test_duplicate_fingerprint_prefers_capture_index", () => {
	const messages = [user("same text"), assistantText("middle"), user("same text")];
	for (const index of [0, 2]) {
		const fingerprint = computeBoundaryFingerprint(messages[index], index);
		assert.equal(resolveBoundaryIndex(messages, fingerprint), index);
	}
});
