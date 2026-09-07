import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { initTheme, TreeSelectorComponent, type SessionTreeNode } from "@earendil-works/pi-coding-agent";

import { installCustomTypeFilter, parseHiddenCustomTypes } from "../tree-filter.ts";

// Configure the same TUI instance used by the selector, including nested installations.
const { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS }: typeof import("@earendil-works/pi-tui") =
	await import(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui"));

initTheme("dark", false);
setKeybindings(new KeybindingsManager({
	...TUI_KEYBINDINGS,
	"app.tree.filter.all": { defaultKeys: "ctrl+a" },
	"app.tree.filter.default": { defaultKeys: "ctrl+d" },
}));

const createTree = (): SessionTreeNode[] => [{
	entry: {
		type: "message", id: "user", parentId: null, timestamp: "2026-09-05T00:00:00Z",
		message: { role: "user", content: "request", timestamp: 1 },
	},
	children: [{
		entry: {
			type: "custom_message", customType: "background-status", display: false,
			id: "update", parentId: "user", timestamp: "2026-09-05T00:00:01Z",
			content: "Background task status",
		},
		children: [{
			entry: {
				type: "custom_message", customType: "other-extension", display: false,
				id: "other", parentId: "update", timestamp: "2026-09-05T00:00:02Z",
				content: "Other context",
			},
			children: [],
		}],
	}],
}];

for (const mode of ["default", "no-tools"] as const) {
	test(`${mode} hides configured types, preserves descendants, and restores them in all`, () => {
		const tree = createTree();
		const original = structuredClone(tree);
		const navigated: string[] = [];
		const selector = new TreeSelectorComponent(
			tree, "other", 20, (id) => navigated.push(id), () => {}, undefined, "update", mode,
		);
		installCustomTypeFilter(selector, ["background-status"]);
		const list = selector.getTreeList();
		assert.equal(list.getSelectedNode()?.entry.id, "user");
		selector.handleInput("\u001b[B");
		assert.equal(list.getSelectedNode()?.entry.id, "other");
		selector.handleInput("\r");
		assert.deepEqual(navigated, ["other"]);

		selector.handleInput("\u0001");
		selector.handleInput("\u001b[A");
		assert.equal(list.getSelectedNode()?.entry.id, "update");
		assert.equal(list.getSelectedNode()?.entry.type, "custom_message");
		selector.handleInput("\u0004");
		assert.equal(list.getSelectedNode()?.entry.id, "user");
		assert.deepEqual(tree, original);
	});
}

test("search excludes configured types in default but finds them in all", () => {
	const selector = new TreeSelectorComponent(createTree(), "other", 20, () => {}, () => {});
	installCustomTypeFilter(selector, ["background-status"]);
	selector.handleInput("Background");
	assert.equal(selector.getTreeList().getSelectedNode(), undefined);
	selector.handleInput("\u0001");
	assert.equal(selector.getTreeList().getSelectedNode()?.entry.id, "update");
});

test("an omitted or empty list leaves custom messages visible", () => {
	for (const config of [undefined, []]) {
		const selector = new TreeSelectorComponent(createTree(), "update", 20, () => {}, () => {});
		installCustomTypeFilter(selector, parseHiddenCustomTypes(config));
		assert.equal(selector.getTreeList().getSelectedNode()?.entry.id, "update");
	}
});

test("multiple configured names are exact and case-sensitive", () => {
	for (const [names, expected] of [
		[["background-status", "other-extension"], "user"],
		[["background", "Background-status", "other-extension"], "update"],
	] as const) {
		const selector = new TreeSelectorComponent(createTree(), "other", 20, () => {}, () => {});
		installCustomTypeFilter(selector, parseHiddenCustomTypes(names));
		assert.equal(selector.getTreeList().getSelectedNode()?.entry.id, expected);
	}
});

test("invalid hiddenCustomTypes values fail at the config boundary", () => {
	for (const value of [null, "background-status", [42], [""], ["   "]]) {
		assert.throws(() => parseHiddenCustomTypes(value), /hiddenCustomTypes must be an array of nonblank custom type names/);
	}
});
