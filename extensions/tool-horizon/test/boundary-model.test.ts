import assert from "node:assert/strict";
import test from "node:test";

import {
	BoundaryPickerCompatibilityError,
	buildBoundaryPickerModel,
	buildNodeMap,
	clampPreviewWindow,
	composeOverlayLines,
	computeVisibleWindowStart,
	decorateTreeRows,
	describeUnavailableReason,
	extractPreviewText,
	filterTreeToBranch,
	flattenTree,
	formatHintKeys,
	layoutHintItems,
	renderBoundaryPickerStatusLines,
	resolveBoundarySelection,
	type BoundaryPickerModel,
	type BoundaryPickerRow,
	type BoundaryPickerThemeLike,
	type ToolHorizonTreeNode,
	type PickerSessionEntry,
} from "../boundary-model.ts";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { showToolHorizonBoundaryPicker } from "../boundary-picker.ts";
import { TOOL_HORIZON_CHECKPOINT_MESSAGE_CUSTOM_TYPE } from "../provenance.ts";
import type { EventMessage } from "../core.ts";

const PLAIN_THEME: BoundaryPickerThemeLike = { fg: (_color, text) => text };

function entry(id: string, type: string, extra: Record<string, unknown> = {}, parentId?: string): PickerSessionEntry {
	return { id, type, parentId, ...extra };
}

function messageEntry(id: string, message: Record<string, unknown>, parentId?: string): PickerSessionEntry {
	return entry(id, "message", { message }, parentId);
}

/** Build a linear tree (the shape a single branch always has) from entries in chronological order */
function linearTree(entries: PickerSessionEntry[]): ToolHorizonTreeNode[] {
	let root: ToolHorizonTreeNode | null = null;
	let cursor: ToolHorizonTreeNode | null = null;
	for (const item of entries) {
		const node: ToolHorizonTreeNode = { entry: item, children: [] };
		if (cursor === null) {
			root = node;
		} else {
			cursor.children.push(node);
		}
		cursor = node;
	}
	return root === null ? [] : [root];
}

function user(text: string): EventMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): EventMessage {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolCall(id: string): EventMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: `/tmp/${id}` } }] };
}

function toolResultMessage(id: string, text: string): EventMessage {
	return { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }] };
}

/** Standard fixture: user -> tool call -> tool result -> assistant text -> user */
function buildFixture() {
	const entries = [
		messageEntry("e1", user("first question")),
		messageEntry("e2", assistantToolCall("t1"), "e1"),
		messageEntry("e3", toolResultMessage("t1", "a".repeat(400)), "e2"),
		messageEntry("e4", assistantText("here is the answer"), "e3"),
		messageEntry("e5", user("second question"), "e4"),
	];
	const rawPayload: EventMessage[] = [
		user("first question"),
		assistantToolCall("t1"),
		toolResultMessage("t1", "a".repeat(400)),
		assistantText("here is the answer"),
		user("second question"),
	];
	const entryIdToRawPayloadIndex = new Map(entries.map((item, index) => [item.id, index]));
	return {
		entries,
		rawPayload,
		fullTree: linearTree(entries),
		branchIds: new Set(entries.map((item) => item.id)),
		entryIdToRawPayloadIndex,
	};
}

function buildModelOrThrow(overrides: Partial<Parameters<typeof buildBoundaryPickerModel>[0]> = {}): BoundaryPickerModel {
	const fixture = buildFixture();
	const model = buildBoundaryPickerModel({
		fullTree: fixture.fullTree,
		currentBranchEntryIds: fixture.branchIds,
		entryIdToRawPayloadIndex: fixture.entryIdToRawPayloadIndex,
		rawPayload: fixture.rawPayload,
		currentBoundaryRawPayloadIndex: null,
		currentBoundaryMode: null,
		...overrides,
	});
	if ("kind" in model) throw new Error(`expected a model, got ${model.kind}`);
	return model;
}

function rowOf(model: BoundaryPickerModel, entryId: string): BoundaryPickerRow {
	const row = model.rowsByEntryId.get(entryId);
	if (!row) throw new Error(`missing row for ${entryId}`);
	return row;
}

test("test_build_boundary_picker_model_marks_safe_mapped_rows_selectable", () => {
	const model = buildModelOrThrow();
	for (const id of ["e1", "e4", "e5"]) {
		assert.equal(rowOf(model, id).kind, "selectable", `${id} should be selectable`);
	}
});

test("test_build_boundary_picker_model_rejects_boundary_that_changes_suffix", () => {
	const model = buildModelOrThrow();
	const row = rowOf(model, "e3");
	assert.equal(row.kind, "unavailable");
	assert.equal(row.reason, "pruning-crosses-boundary");
});

test("test_build_boundary_picker_model_marks_metadata_rows_not_in_payload", () => {
	const entries = [
		messageEntry("e1", user("hello")),
		entry("m1", "model_change", { provider: "anthropic", modelId: "opus" }, "e1"),
		entry("m2", "label", { label: "checkpoint" }, "m1"),
		entry("m3", "custom", { customType: "tool-horizon-state" }, "m2"),
		entry("m4", "thinking_level_change", { thinkingLevel: "high" }, "m3"),
		entry("m5", "session_info", { name: "session" }, "m4"),
		messageEntry("e2", user("later"), "m5"),
	];
	const rawPayload = [user("hello"), user("later")];
	const model = buildBoundaryPickerModel({
		fullTree: linearTree(entries),
		currentBranchEntryIds: new Set(entries.map((item) => item.id)),
		entryIdToRawPayloadIndex: new Map([["e1", 0], ["e2", 1]]),
		rawPayload,
		currentBoundaryRawPayloadIndex: null,
		currentBoundaryMode: null,
	});
	if ("kind" in model) throw new Error("expected a model");

	for (const id of ["m1", "m2", "m3", "m4", "m5"]) {
		const row = rowOf(model, id);
		assert.equal(row.kind, "unavailable", `${id} must be unavailable`);
			assert.equal(row.reason, "not-in-current-payload");
	}
});

test("test_build_boundary_picker_model_marks_compacted_prefix_unavailable", () => {
	const fixture = buildFixture();
	// Simulate compaction: the first two entries are no longer represented in the payload.
	const trimmedPayload = fixture.rawPayload.slice(3);
	const mapping = new Map([["e4", 0], ["e5", 1]]);
	const model = buildBoundaryPickerModel({
		fullTree: fixture.fullTree,
		currentBranchEntryIds: fixture.branchIds,
		entryIdToRawPayloadIndex: mapping,
		rawPayload: trimmedPayload,
		currentBoundaryRawPayloadIndex: null,
		currentBoundaryMode: null,
	});
	if ("kind" in model) throw new Error("expected a model");

	for (const id of ["e1", "e2", "e3"]) {
		const row = rowOf(model, id);
		assert.equal(row.kind, "unavailable");
			assert.equal(row.reason, "not-in-current-payload");
	}
	assert.equal(rowOf(model, "e4").kind, "selectable");
});

test("test_build_boundary_picker_model_excludes_off_branch_rows", () => {
	const fixture = buildFixture();
	const offBranch: PickerSessionEntry = messageEntry("off-1", user("sibling branch"), "e1");
	const treeWithSibling = linearTree(fixture.entries);
	treeWithSibling[0].children.push({ entry: offBranch, children: [] });

	const model = buildBoundaryPickerModel({
		fullTree: treeWithSibling,
		currentBranchEntryIds: fixture.branchIds,
		entryIdToRawPayloadIndex: fixture.entryIdToRawPayloadIndex,
		rawPayload: fixture.rawPayload,
		currentBoundaryRawPayloadIndex: null,
		currentBoundaryMode: null,
	});
	if ("kind" in model) throw new Error("expected a model");

	assert.equal(model.rowsByEntryId.has("off-1"), false, "off-branch entries are filtered out entirely");
});

test("test_build_boundary_picker_model_shares_entry_objects_with_full_tree", () => {
	const fixture = buildFixture();
	const filtered = filterTreeToBranch(fixture.fullTree, fixture.branchIds);
	assert.notEqual(filtered[0], fixture.fullTree[0], "node wrappers are fresh");
	assert.equal(filtered[0].entry, fixture.fullTree[0].entry, "entry objects are shared by reference");
});

test("test_build_boundary_picker_model_marks_checkpoint_messages_extension_owned", () => {
	const entries = [
		messageEntry("e1", user("hello")),
		entry("cp", "custom_message", { customType: TOOL_HORIZON_CHECKPOINT_MESSAGE_CUSTOM_TYPE, content: "<checkpoint/>" }, "e1"),
		messageEntry("e2", user("later"), "cp"),
	];
	const rawPayload: EventMessage[] = [user("hello"), user("later")];
	const model = buildBoundaryPickerModel({
		fullTree: linearTree(entries),
		currentBranchEntryIds: new Set(entries.map((item) => item.id)),
		entryIdToRawPayloadIndex: new Map([["e1", 0], ["e2", 1]]),
		rawPayload,
		currentBoundaryRawPayloadIndex: null,
		currentBoundaryMode: null,
	});
	if ("kind" in model) throw new Error("expected a model");

	const row = rowOf(model, "cp");
	assert.equal(row.kind, "unavailable");
	assert.equal(row.reason, "extension-owned-message");
});

test("test_trailing_tool_only_leaf_assistant_is_selectable", () => {
	// The tree component shows a tool-call-only assistant when it is the current leaf. Such a row has
	// no results after it, so pruning there cannot alter the suffix: it is a legal boundary.
	const entries = [messageEntry("e1", user("hello")), messageEntry("e2", assistantToolCall("t9"), "e1")];
	const rawPayload = [user("hello"), assistantToolCall("t9")];
	const model = buildBoundaryPickerModel({
		fullTree: linearTree(entries),
		currentBranchEntryIds: new Set(["e1", "e2"]),
		entryIdToRawPayloadIndex: new Map([["e1", 0], ["e2", 1]]),
		rawPayload,
		currentBoundaryRawPayloadIndex: null,
		currentBoundaryMode: null,
	});
	if ("kind" in model) throw new Error("expected a model");

	assert.equal(rowOf(model, "e2").kind, "selectable");
});

test("test_hidden_tool_call_reclaim_appears_on_next_safe_row", () => {
	const model = buildModelOrThrow();
	const afterToolExchange = rowOf(model, "e4");
	const beforeToolExchange = rowOf(model, "e1");
	if (afterToolExchange.kind !== "selectable" || beforeToolExchange.kind !== "selectable") {
		throw new Error("expected selectable rows");
	}

	assert.equal(beforeToolExchange.reclaimedTokens, 0, "nothing precedes the first row, so nothing is reclaimed");
	assert.ok(
		afterToolExchange.reclaimedTokens > 0,
		"the row after the tool exchange absorbs the hidden tool call and its result",
	);
});

test("test_reclaim_is_monotonic_in_boundary_position", () => {
	const model = buildModelOrThrow();
	const e4 = rowOf(model, "e4");
	const e5 = rowOf(model, "e5");
	if (e4.kind !== "selectable" || e5.kind !== "selectable") throw new Error("expected selectable rows");

	assert.ok(e5.reclaimedTokens >= e4.reclaimedTokens, "reclaim never decreases as the boundary moves later");
});

test("test_reclaim_estimates_are_stable_across_builds", () => {
	const first = buildModelOrThrow();
	const second = buildModelOrThrow();
	for (const id of ["e1", "e4", "e5"]) {
		const a = rowOf(first, id);
		const b = rowOf(second, id);
		if (a.kind !== "selectable" || b.kind !== "selectable") throw new Error("expected selectable rows");
		assert.equal(a.reclaimedTokens, b.reclaimedTokens);
	}
});

test("test_build_boundary_picker_model_rejects_unstable_fingerprint", () => {
	// An assistant message with empty content yields no fingerprint text and no tool names, so it
	// scores below FINGERPRINT_MATCH_THRESHOLD and can never be re-resolved as a boundary. Offering it
	// as a boundary would store a boundary that silently stops resolving on the next turn.
	const entries = [
		messageEntry("e1", user("hello")),
		messageEntry("e2", { role: "assistant", content: [] }, "e1"),
		messageEntry("e3", user("later"), "e2"),
	];
	const rawPayload: EventMessage[] = [user("hello"), { role: "assistant", content: [] }, user("later")];
	const model = buildBoundaryPickerModel({
		fullTree: linearTree(entries),
		currentBranchEntryIds: new Set(["e1", "e2", "e3"]),
		entryIdToRawPayloadIndex: new Map([["e1", 0], ["e2", 1], ["e3", 2]]),
		rawPayload,
		currentBoundaryRawPayloadIndex: null,
		currentBoundaryMode: null,
	});
	if ("kind" in model) throw new Error("expected a model");

	const row = rowOf(model, "e2");
	assert.equal(row.kind, "unavailable");
	assert.equal(row.reason, "boundary-not-stable");
});

test("test_initial_selection_uses_current_boundary_entry", () => {
	const model = buildModelOrThrow({ currentBoundaryRawPayloadIndex: 3, currentBoundaryMode: "from-entry" });
	assert.equal(model.initialSelectedId, "e4");
	assert.equal(model.currentBoundaryEntryId, "e4");
	assert.equal(model.currentBoundaryMode, "from-entry");
	assert.equal(rowOf(model, "e4").isCurrentBoundary, true);
});

test("test_initial_selection_uses_latest_selectable_when_boundary_missing", () => {
	const model = buildModelOrThrow();
	assert.equal(model.initialSelectedId, "e5", "newest selectable row");
	assert.equal(model.currentBoundaryEntryId, null);
	assert.equal(model.currentBoundaryMode, null);
});

test("test_build_boundary_picker_model_reports_empty_tree", () => {
	const result = buildBoundaryPickerModel({
		fullTree: [],
		currentBranchEntryIds: new Set(),
		entryIdToRawPayloadIndex: new Map(),
		rawPayload: [],
		currentBoundaryRawPayloadIndex: null,
		currentBoundaryMode: null,
	});
	assert.deepEqual(result, { kind: "empty-tree" });
});

test("test_build_boundary_picker_model_reports_no_selectable_boundaries", () => {
	const entries = [entry("m1", "model_change", { provider: "anthropic", modelId: "opus" })];
	const result = buildBoundaryPickerModel({
		fullTree: linearTree(entries),
		currentBranchEntryIds: new Set(["m1"]),
		entryIdToRawPayloadIndex: new Map(),
		rawPayload: [user("unrelated")],
		currentBoundaryRawPayloadIndex: null,
		currentBoundaryMode: null,
	});
	assert.deepEqual(result, { kind: "no-selectable-boundaries" });
});

test("test_resolve_boundary_selection_rejects_unavailable_row", () => {
	const model = buildModelOrThrow();
	const result = resolveBoundarySelection(model, "e3");
	assert.equal(result.ok, false);
	assert.equal(result.row?.kind, "unavailable");
});

test("test_resolve_boundary_selection_returns_raw_index_without_visible_remap", () => {
	const model = buildModelOrThrow();
	const result = resolveBoundarySelection(model, "e4");
	assert.equal(result.ok, true);
	assert.equal(result.selection.rawPayloadIndex, 3, "raw index is carried straight through");
	assert.equal(result.selection.entryId, "e4");
});

test("test_resolve_boundary_selection_handles_unknown_entry", () => {
	const model = buildModelOrThrow();
	const result = resolveBoundarySelection(model, "nonexistent");
	assert.equal(result.ok, false);
	assert.equal(result.row, null);
});

test("test_compute_visible_window_start_matches_upstream_expression", () => {
	assert.equal(computeVisibleWindowStart({ selectedIndex: 0, maxVisibleLines: 5, filteredNodeCount: 20 }), 0);
	assert.equal(computeVisibleWindowStart({ selectedIndex: 10, maxVisibleLines: 5, filteredNodeCount: 20 }), 8);
	assert.equal(computeVisibleWindowStart({ selectedIndex: 19, maxVisibleLines: 5, filteredNodeCount: 20 }), 15);
	assert.equal(computeVisibleWindowStart({ selectedIndex: 2, maxVisibleLines: 10, filteredNodeCount: 4 }), 0);
});

function decorationFixture(rowCount: number) {
	const nodes = Array.from({ length: rowCount }, (_, index) => ({
		node: { entry: entry(`n${index}`, "message"), children: [] } as ToolHorizonTreeNode,
	}));
	const rows = new Map<string, BoundaryPickerRow>(
		nodes.map((item, index) => [
			item.node.entry.id,
			index % 2 === 0
				? { kind: "selectable", entryId: item.node.entry.id, rawPayloadIndex: index, reclaimedTokens: 1500, isCurrentBoundary: false }
				: { kind: "unavailable", entryId: item.node.entry.id, reason: "pruning-crosses-boundary", isCurrentBoundary: false },
		]),
	);
	return { nodes, rows };
}

test("test_decorate_tree_rows_maps_visible_window_to_correct_entries", () => {
	const { nodes, rows } = decorationFixture(20);
	// Focused deep in the list, so the window is scrolled: start = 10 - 2 = 8.
	const lines = [...Array.from({ length: 5 }, (_, index) => `row-${8 + index}`), "(10/20)"];
	const decorated = decorateTreeRows({
		lines,
		filteredNodes: nodes,
		selectedIndex: 10,
		maxVisibleLines: 5,
		width: 60,
		rowsByEntryId: rows,
		theme: PLAIN_THEME,
	});

	// n8 is selectable (even index) and must carry an estimate; n9 must not.
	assert.ok(decorated[0].includes("row-8"));
	assert.ok(decorated[0].includes("tokens"), "row for n8 carries its estimate");
	assert.ok(decorated[1].includes("row-9"));
	assert.equal(decorated[1].includes("tokens"), false, "unavailable row carries no estimate");
});

test("test_decorate_tree_rows_preserves_status_line", () => {
	const { nodes, rows } = decorationFixture(3);
	const lines = ["row-0", "row-1", "row-2", "(1/3)"];
	const decorated = decorateTreeRows({
		lines,
		filteredNodes: nodes,
		selectedIndex: 0,
		maxVisibleLines: 5,
		width: 60,
		rowsByEntryId: rows,
		theme: PLAIN_THEME,
	});

	assert.equal(decorated.length, 4);
	assert.ok(decorated[3].includes("(1/3)"));
	assert.equal(decorated[3].includes("tokens"), false, "the status line is never decorated as a node row");
});

test("test_decorate_tree_rows_handles_empty_filter_result", () => {
	const decorated = decorateTreeRows({
		lines: ["No entries found", "(0/0)"],
		filteredNodes: [],
		selectedIndex: 0,
		maxVisibleLines: 5,
		width: 40,
		rowsByEntryId: new Map(),
		theme: PLAIN_THEME,
	});

	assert.equal(decorated.length, 2);
	assert.ok(decorated[0].includes("No entries found"));
	assert.ok(decorated[1].includes("(0/0)"));
});

test("test_decorate_tree_rows_right_aligns_reclaim_estimate", () => {
	const width = 50;
	const rows = new Map<string, BoundaryPickerRow>([
		["n0", { kind: "selectable", entryId: "n0", rawPayloadIndex: 0, reclaimedTokens: 1500, isCurrentBoundary: false }],
	]);
	const decorated = decorateTreeRows({
		lines: ["short row", "(1/1)"],
		filteredNodes: [{ node: { entry: entry("n0", "message"), children: [] } }],
		selectedIndex: 0,
		maxVisibleLines: 5,
		width,
		rowsByEntryId: rows,
		theme: PLAIN_THEME,
	});

	assert.equal(visibleWidth(decorated[0]), width, "decorated row fills the full width");
	assert.ok(decorated[0].endsWith("−1.5k context tokens"), "estimate is flush right");
});

test("test_decorate_tree_rows_renders_zero_reclaim_for_selectable_row", () => {
	const rows = new Map<string, BoundaryPickerRow>([
		["n0", { kind: "selectable", entryId: "n0", rawPayloadIndex: 0, reclaimedTokens: 0, isCurrentBoundary: false }],
	]);
	const decorated = decorateTreeRows({
		lines: ["a row", "(1/1)"],
		filteredNodes: [{ node: { entry: entry("n0", "message"), children: [] } }],
		selectedIndex: 0,
		maxVisibleLines: 5,
		width: 40,
		rowsByEntryId: rows,
		theme: PLAIN_THEME,
	});

	assert.ok(decorated[0].includes("−0 context tokens"), "zero must render, or a selectable row reads as unavailable");
});

test("test_decorate_tree_rows_omits_reclaim_when_terminal_is_too_narrow", () => {
	const width = 18;
	const rows = new Map<string, BoundaryPickerRow>([
		["n0", { kind: "selectable", entryId: "n0", rawPayloadIndex: 0, reclaimedTokens: 1500, isCurrentBoundary: false }],
	]);
	const decorated = decorateTreeRows({
		lines: ["a reasonably long row", "(1/1)"],
		filteredNodes: [{ node: { entry: entry("n0", "message"), children: [] } }],
		selectedIndex: 0,
		maxVisibleLines: 5,
		width,
		rowsByEntryId: rows,
		theme: PLAIN_THEME,
	});

	assert.equal(decorated[0].includes("tokens"), false, "estimate is dropped rather than crushing the tree text");
	// truncateToWidth appends an ANSI-wrapped ellipsis, so raw string length overshoots; visible width
	// is the invariant that actually governs terminal layout.
	for (const line of decorated) assert.ok(visibleWidth(line) <= width, "no line exceeds the requested width");
});

test("test_extract_preview_text_returns_placeholder_for_empty_entry", () => {
	assert.equal(extractPreviewText(entry("x", "model_change")), "(no text content)");
	assert.equal(extractPreviewText(messageEntry("m", { role: "user", content: [] })), "(no text content)");
});

test("test_extract_preview_text_reads_common_entry_shapes", () => {
	assert.equal(extractPreviewText(messageEntry("m", { role: "user", content: [{ type: "text", text: "hi" }] })), "hi");
	assert.equal(extractPreviewText(messageEntry("b", { role: "bashExecution", command: "ls -la" })), "ls -la");
	assert.equal(extractPreviewText(entry("c", "compaction", { summary: "compacted" })), "compacted");
	assert.equal(extractPreviewText(entry("s", "branch_summary", { summary: "branch" })), "branch");
	assert.equal(
		extractPreviewText(messageEntry("e", { role: "assistant", errorMessage: "boom" })),
		"(error) boom",
	);
});

test("test_clamp_preview_window_clamps_offset_and_adds_indicators", () => {
	const bodyLines = Array.from({ length: 10 }, (_, index) => `line-${index}`);

	const clampedHigh = clampPreviewWindow({
		bodyLines,
		height: 4,
		offset: 999,
		truncatedToMaxLines: false,
		theme: PLAIN_THEME,
		width: 40,
	});
	// The bound accounts for the row the "lines above" indicator consumes once the body is scrolled,
	// so the last body line stays reachable (see test_preview_bottom_window_contains_final_line).
	assert.equal(clampedHigh.offset, 7, "offset clamps to bodyLines.length - height + 1 when scrolled");
	assert.equal(clampedHigh.lines.length, 4);
	assert.ok(clampedHigh.lines[0].includes("line(s) above"));

	const clampedLow = clampPreviewWindow({
		bodyLines,
		height: 4,
		offset: -5,
		truncatedToMaxLines: false,
		theme: PLAIN_THEME,
		width: 40,
	});
	assert.equal(clampedLow.offset, 0);
	assert.ok(clampedLow.lines[clampedLow.lines.length - 1].includes("more line(s)"));

	const noScroll = clampPreviewWindow({
		bodyLines: ["only line"],
		height: 3,
		offset: 0,
		truncatedToMaxLines: false,
		theme: PLAIN_THEME,
		width: 40,
	});
	assert.equal(noScroll.lines.length, 3, "short bodies are padded to the pane height");
	assert.equal(noScroll.lines[1], "");
});

test("test_deep_linear_session_tree_builds_without_stack_overflow", () => {
	// Session trees are append-only and compaction never removes entries, so depth grows without bound
	// in exactly the long sessions this extension exists to serve. Recursive traversal would overflow.
	const DEPTH = 20000;
	const entries = Array.from({ length: DEPTH }, (_, index) =>
		messageEntry(`e${index}`, user(`message ${index}`), index === 0 ? undefined : `e${index - 1}`),
	);
	const fullTree = linearTree(entries);
	const branchIds = new Set(entries.map((item) => item.id));

	const filtered = filterTreeToBranch(fullTree, branchIds);
	const flattened = flattenTree(filtered);
	const nodeMap = buildNodeMap(fullTree);

	assert.equal(flattened.length, DEPTH);
	assert.equal(nodeMap.size, DEPTH);
	assert.equal(flattened[0].entry.id, "e0", "preorder is preserved");
	assert.equal(flattened[DEPTH - 1].entry.id, `e${DEPTH - 1}`);
	assert.equal(flattened[0].entry, entries[0], "entry objects stay shared by reference");
});

test("test_preview_bottom_window_contains_final_line", () => {
	const bodyLines = Array.from({ length: 10 }, (_, index) => `line-${index}`);
	const clamped = clampPreviewWindow({
		bodyLines,
		height: 4,
		offset: Number.MAX_SAFE_INTEGER,
		truncatedToMaxLines: false,
		theme: PLAIN_THEME,
		width: 40,
	});

	assert.ok(
		clamped.lines.some((line) => line.includes("line-9")),
		"the final body line must be reachable at maximum scroll",
	);
});

test("test_preview_truncated_bottom_contains_final_retained_line", () => {
	// The truncation notice occupies a body slot of its own, so the scroll bound has to reserve it or
	// the last retained line can never be displayed.
	const bodyLines = Array.from({ length: 200 }, (_, index) => `line-${index}`);
	const clamped = clampPreviewWindow({
		bodyLines,
		height: 4,
		offset: Number.MAX_SAFE_INTEGER,
		truncatedToMaxLines: true,
		theme: PLAIN_THEME,
		width: 60,
	});

	assert.ok(clamped.lines.some((line) => line.includes("line-199")), "final retained line is reachable");
	assert.ok(clamped.lines.some((line) => line.includes("truncated to")), "truncation is still disclosed");
});

test("test_preview_every_body_line_is_reachable_in_a_two_line_pane", () => {
	// Indicators must never take the last body row: a pane showing only "lines above" and "lines below"
	// says where you are while hiding what is there.
	const bodyLines = Array.from({ length: 10 }, (_, index) => `line-${index}`);
	const seen = new Set<string>();
	for (let offset = 0; offset < 20; offset++) {
		const clamped = clampPreviewWindow({
			bodyLines,
			height: 2,
			offset,
			truncatedToMaxLines: false,
			theme: PLAIN_THEME,
			width: 40,
		});
		for (const line of bodyLines) if (clamped.lines.some((rendered) => rendered.includes(line))) seen.add(line);
	}

	assert.equal(seen.size, bodyLines.length, "every body line is reachable at some offset");
});

test("test_preview_single_line_pane_shows_body_not_indicators", () => {
	const clamped = clampPreviewWindow({
		bodyLines: ["line-0", "line-1", "line-2"],
		height: 1,
		offset: 1,
		truncatedToMaxLines: true,
		theme: PLAIN_THEME,
		width: 40,
	});
	assert.deepEqual(clamped.lines, ["line-1"]);
});

test("test_preview_tiny_pane_prefers_body_over_truncation_notice", () => {
	// With two indicators competing for two rows, the body wins: disclosure is worthless if it hides
	// the content it describes.
	const clamped = clampPreviewWindow({
		bodyLines: ["a", "b"],
		height: 2,
		offset: Number.MAX_SAFE_INTEGER,
		truncatedToMaxLines: true,
		theme: PLAIN_THEME,
		width: 40,
	});

	assert.ok(clamped.lines.some((line) => line.includes("b")), "the last body line stays reachable");
});

// The native selector renders title/help/search chrome BEFORE its entry rows, so a short terminal
// must drop that chrome rather than the rows that identify the boundary being committed.
const CHROME_LINES = ["", "───", "  Session Tree", "  help", "  Type to search", "───", ""];

test("test_format_hint_keys_compacts_shared_modifiers_and_names_arrows", () => {
	assert.equal(formatHintKeys(["ctrl+d", "ctrl+t", "ctrl+u", "ctrl+l", "ctrl+a"]), "ctrl+d/t/u/l/a");
	assert.equal(formatHintKeys(["up", "down"]), "↑/↓");
	assert.equal(formatHintKeys(["shift+pageUp", "shift+pageDown"]), "shift+pgup/pgdn");
	assert.equal(formatHintKeys(["option+left", "option+right"]), "option+←/→");
	assert.equal(formatHintKeys(["escape", "ctrl+c"]), "escape/ctrl+c", "mixed modifiers are not compacted");
});

test("test_format_hint_keys_is_empty_when_nothing_is_bound", () => {
	// An unbound action must not be advertised, which is how the help row stays honest when a
	// keybinding is removed.
	assert.equal(formatHintKeys([]), "");
	assert.equal(formatHintKeys(["", ""]), "");
	assert.equal(formatHintKeys(["", "enter"]), "enter");
});

test("test_layout_hint_items_wraps_within_width", () => {
	const items = ["↑/↓ move", "←/→ page", "option+←/→ fold", "filters ctrl+d/t/u/l/a", "enter set horizon"];
	const wide = layoutHintItems(items, 100);
	assert.equal(wide.length, 1);
	for (const item of items) assert.ok(wide[0].includes(item));

	const narrow = layoutHintItems(items, 40);
	assert.ok(narrow.length > 1);
	for (const line of narrow) assert.ok(visibleWidth(line) <= 40);
	const joined = narrow.join(" ");
	for (const item of items) assert.ok(joined.includes(item), `${item} survives wrapping`);
});

test("test_compose_overlay_lines_preserves_status_and_tree_rows_on_short_terminals", () => {
	const selectorLines = [...CHROME_LINES, "○ row-0", "○ row-1", "(2/2)", "", "───"];
	const composed = composeOverlayLines({
		selectorLines,
		treeRegion: { start: CHROME_LINES.length, count: 2, focusedOffset: 0 },
		statusLines: ["---", "  Tool horizon begins at this entry · −5.0k context tokens", "  hint"],
		renderPreview: (height) => Array.from({ length: height }, () => "preview"),
		height: 6,
	});

	assert.equal(composed.lines.length, 6);
	assert.ok(composed.lines.some((line) => line.includes("Tool horizon begins")), "status survives a short terminal");
	assert.ok(composed.lines.some((line) => line.includes("row-0")), "tree rows outrank decorative chrome");
	assert.ok(composed.focusedRowVisible);
});

test("test_compose_overlay_lines_preserves_focused_row_when_tree_window_is_cropped", () => {
	// The native selector keeps a five-row minimum window, so a cropped pane can easily cut the cursor
	// off the bottom — which is exactly where initial focus lands.
	const rows = ["○ row-0", "○ row-1", "○ row-2", "○ row-3", "○ row-4"];
	const composed = composeOverlayLines({
		selectorLines: [...CHROME_LINES, ...rows, "(5/5)", "", "───"],
		treeRegion: { start: CHROME_LINES.length, count: rows.length, focusedOffset: 4 },
		statusLines: ["---", "  status", "  hint"],
		renderPreview: () => [],
		height: 7,
	});

	assert.ok(composed.lines.some((line) => line.includes("row-4")), "the focused row survives cropping");
	assert.ok(composed.focusedRowVisible);
});

test("test_compose_overlay_lines_reports_focused_row_hidden_when_no_row_fits", () => {
	// The caller refuses to commit when this is false: an invisible cursor must not decide what gets
	// pruned, even if unrelated rows happen to remain on screen.
	const composed = composeOverlayLines({
		selectorLines: [...CHROME_LINES, "○ row-0", "(1/1)"],
		treeRegion: { start: CHROME_LINES.length, count: 1, focusedOffset: 0 },
		statusLines: ["---", "  status", "  hint"],
		renderPreview: () => [],
		height: 3,
	});

	assert.equal(composed.lines.length, 3);
	assert.equal(composed.treeRowsVisible, 0);
	assert.equal(composed.focusedRowVisible, false);
	assert.ok(composed.lines.some((line) => line.includes("status")), "status still wins the last rows");
});

test("test_compose_overlay_lines_reports_focused_row_hidden_when_region_is_unlocatable", () => {
	const composed = composeOverlayLines({
		selectorLines: [...CHROME_LINES],
		treeRegion: { start: CHROME_LINES.length, count: 0, focusedOffset: -1 },
		statusLines: ["  status"],
		renderPreview: () => [],
		height: 20,
	});
	assert.equal(composed.focusedRowVisible, false);
});

test("test_compose_overlay_lines_fills_and_clamps_to_height", () => {
	const composed = composeOverlayLines({
		selectorLines: ["tree-0"],
		treeRegion: { start: 0, count: 1, focusedOffset: 0 },
		statusLines: ["status"],
		renderPreview: (height) => Array.from({ length: height }, (_, index) => `preview-${index}`),
		height: 5,
	});
	assert.equal(composed.lines.length, 5);
	assert.deepEqual(composed.lines.slice(0, 2), ["tree-0", "status"]);
	assert.equal(composed.treeRowsVisible, 1);
	assert.ok(composed.focusedRowVisible);

	const zero = composeOverlayLines({
		selectorLines: ["tree-0"],
		treeRegion: { start: 0, count: 1, focusedOffset: 0 },
		statusLines: ["status"],
		renderPreview: () => ["preview"],
		height: 0,
	});
	assert.deepEqual(zero.lines, []);
	assert.equal(zero.focusedRowVisible, false);
});

test("test_decorate_tree_rows_rejects_unexpected_flat_node_shape", () => {
	// Silently degrading to undecorated rows would hide which boundaries are legal; the picker fails
	// closed into an explicit incompatibility state instead.
	assert.throws(
		() =>
			decorateTreeRows({
				lines: ["row-0", "(1/1)"],
				filteredNodes: [{} as unknown as { node: ToolHorizonTreeNode }],
				selectedIndex: 0,
				maxVisibleLines: 5,
				width: 40,
				rowsByEntryId: new Map(),
				theme: PLAIN_THEME,
			}),
		BoundaryPickerCompatibilityError,
	);
});

test("test_decorate_tree_rows_rejects_changed_render_row_count", () => {
	// An extra native status line would shift every row against its estimate, attributing one entry's
	// reclaim figure to another.
	const node = { entry: messageEntry("e0", user("hi")), children: [] } as unknown as ToolHorizonTreeNode;
	assert.throws(
		() =>
			decorateTreeRows({
				lines: ["row-0", "extra status", "(1/1)"],
				filteredNodes: [{ node }],
				selectedIndex: 0,
				maxVisibleLines: 5,
				width: 40,
				rowsByEntryId: new Map(),
				theme: PLAIN_THEME,
			}),
		BoundaryPickerCompatibilityError,
	);
});

test("test_clamp_preview_window_reports_max_line_truncation", () => {
	// Height 3 is the smallest pane that can disclose truncation without displacing body content; at
	// height 2 the body wins (see test_preview_tiny_pane_prefers_body_over_truncation_notice).
	const clamped = clampPreviewWindow({
		bodyLines: ["a", "b"],
		height: 3,
		offset: 0,
		truncatedToMaxLines: true,
		theme: PLAIN_THEME,
		width: 40,
	});
	assert.deepEqual(clamped.lines.slice(0, 2), ["a", "b"]);
	assert.ok(clamped.lines[2].includes("truncated to 200 lines"));
});

test("test_describe_unavailable_reason_covers_every_reason", () => {
	for (const reason of [
		"not-in-current-payload",
		"boundary-not-stable",
		"pruning-crosses-boundary",
		"extension-owned-message",
	] as const) {
		assert.ok(describeUnavailableReason(reason).length > 0);
	}
});

test("test_render_boundary_picker_status_uses_horizon_copy_and_red_savings", () => {
	const theme: BoundaryPickerThemeLike = { fg: (color, text) => `<${color}>${text}</${color}>` };
	const lines = renderBoundaryPickerStatusLines({
		row: {
			kind: "selectable",
			entryId: "e1",
			rawPayloadIndex: 0,
			reclaimedTokens: 12400,
			isCurrentBoundary: false,
		},
		currentBoundaryMode: null,
		currentBoundaryHidden: false,
		flash: null,
		width: 100,
		theme,
	});

	assert.ok(lines[0].includes("Tool horizon begins at this entry"));
	assert.ok(lines[0].includes("<error>−12.4k context tokens</error>"));
	assert.ok(!lines[0].includes("Would reclaim"));
	assert.ok(!lines[0].includes("~"));
});

test("test_narrow_status_preserves_savings_when_row_suffix_is_omitted", () => {
	const lines = renderBoundaryPickerStatusLines({
		row: {
			kind: "selectable",
			entryId: "e1",
			rawPayloadIndex: 0,
			reclaimedTokens: 12400,
			isCurrentBoundary: false,
		},
		currentBoundaryMode: null,
		currentBoundaryHidden: false,
		flash: null,
		width: 29,
		theme: PLAIN_THEME,
	});

	assert.ok(lines[0].includes("−12.4k context tokens"));
	assert.ok(visibleWidth(lines[0]) <= 29);
});

test("test_render_boundary_picker_status_describes_current_horizon_modes", () => {
	const row = {
		kind: "selectable" as const,
		entryId: "e1",
		rawPayloadIndex: 0,
		reclaimedTokens: 0,
		isCurrentBoundary: true,
	};
	const fromEntryLines = renderBoundaryPickerStatusLines({
		row,
		currentBoundaryMode: "from-entry",
		currentBoundaryHidden: false,
		flash: null,
		width: 100,
		theme: PLAIN_THEME,
	});
	const afterEntryLines = renderBoundaryPickerStatusLines({
		row,
		currentBoundaryMode: "after-entry",
		currentBoundaryHidden: false,
		flash: null,
		width: 100,
		theme: PLAIN_THEME,
	});

	assert.equal(fromEntryLines[1], "  Current horizon");
	assert.equal(afterEntryLines[1], "  Current horizon begins after this entry; Enter moves it to this entry");
});

test("test_render_boundary_picker_status_reports_hidden_current_horizon", () => {
	const lines = renderBoundaryPickerStatusLines({
		row: null,
		currentBoundaryMode: "from-entry",
		currentBoundaryHidden: true,
		flash: null,
		width: 100,
		theme: PLAIN_THEME,
	});

	assert.equal(lines.at(-1), "  Current horizon is on a row hidden by the active filter");
});

test("test_tool_horizon_picker_overlay_renders_with_preview_space", async () => {
	initTheme();
	const fixture = buildFixture();
	const model = buildModelOrThrow();
	let renderedLines: string[] = [];
	const context = {
		ui: {
			custom: async (factory: (
				tui: { terminal: { rows: number }; requestRender(): void; setFocus(component: unknown): void },
				theme: { fg(color: string, text: string): string; bold(text: string): string },
				keybindings: unknown,
				done: (value: unknown) => void,
			) => { render(width: number): string[] }) => {
				const overlay = factory(
					{ terminal: { rows: 40 }, requestRender() {}, setFocus() {} },
					{ fg: (_color, text) => text, bold: (text) => text },
					undefined,
					() => {},
				);
				renderedLines = overlay.render(100);
				return null;
			},
		},
	} as unknown as ExtensionContext;

	await showToolHorizonBoundaryPicker(context, {
		fullTree: fixture.fullTree,
		currentLeafId: "e5",
		model,
	});

	assert.equal(renderedLines.length, 40);
	assert.ok(renderedLines.some((line) => line.includes("Tool horizon begins at this entry")));
});
