import type { SessionTreeNode, TreeSelectorComponent } from "@earendil-works/pi-coding-agent";

type TreeListInternals = {
	filterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	filteredNodes: Array<{ node: SessionTreeNode }>;
	recalculateVisualStructure(): void;
	applyFilter(): void;
};

export const parseHiddenCustomTypes = (value: unknown): string[] => {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((name): name is string => typeof name === "string" && name.trim().length > 0)) {
		throw new Error("hiddenCustomTypes must be an array of nonblank custom type names");
	}
	return value;
};

/** Hide exact customType matches in default/no-tools views; other filters retain them. */
export const installCustomTypeFilter = (selector: TreeSelectorComponent, customTypes: readonly string[]): void => {
	const hiddenTypes = new Set(customTypes);
	if (hiddenTypes.size === 0) return;
	// Pi exposes no entry-filter hook; run before its layout and cursor reconciliation.
	const list = selector.getTreeList() as unknown as TreeListInternals;
	const recalculateVisualStructure = list.recalculateVisualStructure.bind(list);
	list.recalculateVisualStructure = () => {
		if (list.filterMode === "default" || list.filterMode === "no-tools") {
			list.filteredNodes = list.filteredNodes.filter(({ node: { entry } }) =>
				entry.type !== "custom_message" || !hiddenTypes.has(entry.customType),
			);
		}
		recalculateVisualStructure();
	};
	list.applyFilter();
};
