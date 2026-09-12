/**
	* tool-horizon boundary picker overlay
 *
 * Wraps Pi's native session-tree selector so a pruning boundary can be chosen from the same view
 * `/tree` shows, with a live preview of the focused entry and per-row reclaim estimates.
 *
 * This module is deliberately thin: every decision (which rows are legal, what each reclaims, how a
 * row is decorated, how a preview is rendered) lives in `boundary-model.ts`, which is pure and
 * unit-tested. What remains here is terminal wiring, focus, scroll state, and input routing.
 */

import { TreeSelectorComponent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
	type Keybinding,
} from "@earendil-works/pi-tui";

import {
	assertFilteredNodesShape,
	buildNodeMap,
	clampPreviewWindow,
	composeOverlayLines,
	computeVisibleWindowStart,
	decorateTreeRows,
	describeUnavailableReason,
	formatHintKeys,
	layoutHintItems,
	renderBoundaryPickerStatusLines,
	renderPreviewBody,
	resolveBoundarySelection,
	BoundaryPickerCompatibilityError,
	MAX_PREVIEW_LINES,
	type BoundaryPickerModel,
	type BoundaryPickerSelection,
	type BoundaryPickerThemeLike,
	type ToolHorizonTreeNode,
} from "./boundary-model.ts";

export { BoundaryPickerCompatibilityError } from "./boundary-model.ts";

const FLASH_DURATION_MS = 2000;

/** Fraction of terminal height handed to the tree selector, matching the sibling anycopy overlay */
const SELECTOR_HEIGHT_RATIO = 0.65;

/** Horizontal chrome this overlay adds around the native tree ("  " indent on every row) */
const OVERLAY_HORIZONTAL_CHROME = 2;

const MIN_INNER_WIDTH = 10;

/**
	* Native selector actions that have no meaning while choosing a boundary
	*
	* Fold and branch navigation are blocked because the picker shows one branch. `isFoldable` requires
	* a parent with more than one visible child, which never happens in a linear branch — except at the
	* root, where it holds unconditionally, so folding there would collapse the whole conversation into
	* a single row. Everywhere else the key falls through to branch-segment navigation, which without
	* branch points merely jumps to the top or bottom.
	*/
const BLOCKED_SELECTOR_ACTIONS = [
	"app.tree.editLabel",
	"app.tree.toggleLabelTimestamp",
	"app.message.copy",
	"app.tree.foldOrUp",
	"app.tree.unfoldOrDown",
] as const;

/**
	* Filter mode the picker opens in
	*
	* `no-tools` is the native default minus tool results. A boundary cannot be placed inside a turn's
	* tool sequence anyway (pruning there would orphan a tool call from its result), so listing those
	* rows only crowds out the messages that can actually begin a horizon. Ctrl+T restores them.
	*/
const INITIAL_FILTER_MODE = "no-tools";

/**
	* The first key bound to an action, named the way the platform names it
	*
	* The native help shows one key per action rather than every alternative, and macOS calls Alt
	* "option"; both are mirrored here so the picker's row reads like the rest of Pi.
	*/
function primaryKey(binding: Keybinding): string {
	const key = getKeybindings().getKeys(binding)[0] ?? "";
	return process.platform === "darwin" ? key.replace(/\balt\b/g, "option") : key;
}

/** Position of the native help row among the selector's children, and what identifies it */
const HELP_CHILD_INDEX = 3;
const HELP_PROBE_WIDTH = 200;
const NATIVE_HELP_TOKENS = ["filters", "copy"] as const;

/**
	* The picker's own help row, replacing the native one
	*
	* The native row advertises copy, label, and label-timestamp actions that this overlay blocks, and
	* says nothing about setting a boundary or scrolling the preview. Keys are resolved through the
	* keybinding manager so a rebound key is described correctly.
	*/
class BoundaryPickerHelp implements Component {
	constructor(private readonly theme: BoundaryPickerThemeLike) {}

	invalidate(): void {}

	render(width: number): string[] {
		/** An action with no bound key is not worth advertising */
		const hint = (keys: readonly string[], label: string, labelFirst = false): string | null => {
			const text = formatHintKeys(keys);
			if (text === "") return null;
			return labelFirst ? `${label} ${text}` : `${text} ${label}`;
		};

		const items = [
			hint([primaryKey("tui.select.up"), primaryKey("tui.select.down")], "move"),
			hint([primaryKey("tui.editor.cursorLeft"), primaryKey("tui.editor.cursorRight")], "page"),
			hint(["shift+up", "shift+down"], "scroll preview"),
			hint(["shift+pageUp", "shift+pageDown"], "page preview"),
			hint(
				[
					primaryKey("app.tree.filter.default"),
					primaryKey("app.tree.filter.noTools"),
					primaryKey("app.tree.filter.userOnly"),
					primaryKey("app.tree.filter.labeledOnly"),
					primaryKey("app.tree.filter.all"),
				],
				"filters",
				true,
			),
			hint([primaryKey("tui.select.confirm")], "set horizon"),
			hint([primaryKey("tui.select.cancel")], "cancel"),
		].filter((item): item is string => item !== null);

		return layoutHintItems(items, width).map((line) => this.theme.fg("muted", line));
	}
}

/**
	* Swap the native help row for the picker's own
	*
	* Args:
	*     selector (TreeSelectorComponent): the component whose chrome is being adjusted
	*     help (Component): the replacement row
	*
	* Raises:
	*     BoundaryPickerCompatibilityError: when the native help row is not where it is expected, since
	*         leaving it in place would advertise actions the picker blocks
	*/
function replaceNativeHelpRow(selector: TreeSelectorComponent, help: Component): void {
	const children = (selector as unknown as { children?: unknown }).children;
	if (!Array.isArray(children) || children.length <= HELP_CHILD_INDEX) {
		throw new BoundaryPickerCompatibilityError("tree chrome layout changed");
	}
	const candidate = children[HELP_CHILD_INDEX] as Component | undefined;
	const rendered = typeof candidate?.render === "function" ? candidate.render(HELP_PROBE_WIDTH).join(" ") : "";
	if (!NATIVE_HELP_TOKENS.every((token) => rendered.includes(token))) {
		throw new BoundaryPickerCompatibilityError("tree help row not found");
	}
	children[HELP_CHILD_INDEX] = help;
}

type TreeListInternals = {
	filteredNodes: Array<{ node: ToolHorizonTreeNode }>;
	selectedIndex: number;
	maxVisibleLines: number;
};

type TreeListLike = {
	render: (width: number) => string[];
	getSelectedNode: () => ToolHorizonTreeNode | undefined;
};

/**
	* Validate every private tree-list assumption this overlay later depends on
	*
	* Row decoration is what carries the availability and reclaim contract, so an overlay that renders
	* without it would invite the user to choose boundaries with no indication of which are legal. Any
	* shape mismatch therefore fails closed with a typed error rather than degrading.
	*
	* Args:
	*     treeList (unknown): the object returned by TreeSelectorComponent.getTreeList()
	*
	* Returns:
	*     The same object, narrowed to the internals actually used
	*
	* Raises:
	*     BoundaryPickerCompatibilityError: when any depended-upon field or method is missing or reshaped
	*/
function readTreeListInternals(treeList: unknown): TreeListInternals {
	const candidate = treeList as Partial<TreeListInternals & TreeListLike> | null;
	if (!candidate || typeof candidate !== "object") throw new BoundaryPickerCompatibilityError("tree list unavailable");
	if (typeof candidate.render !== "function") throw new BoundaryPickerCompatibilityError("render is not a function");
	if (typeof candidate.getSelectedNode !== "function") {
		throw new BoundaryPickerCompatibilityError("getSelectedNode is not a function");
	}
	if (!Array.isArray(candidate.filteredNodes)) throw new BoundaryPickerCompatibilityError("filteredNodes missing");
	if (!Number.isInteger(candidate.selectedIndex)) throw new BoundaryPickerCompatibilityError("selectedIndex is not an integer");
	if (!Number.isInteger(candidate.maxVisibleLines) || (candidate.maxVisibleLines as number) <= 0) {
		throw new BoundaryPickerCompatibilityError("maxVisibleLines is not a positive integer");
	}
	// An empty list is legitimate (an over-narrow search); a populated one is checked element by element.
	assertFilteredNodesShape(candidate.filteredNodes, candidate.selectedIndex as number);
	return candidate as TreeListInternals;
}

class BoundaryPickerOverlay implements Focusable {
	private flashMessage: { text: string; tone: "warning" | "error" } | null = null;
	private flashTimer: ReturnType<typeof setTimeout> | null = null;
	private previewScrollOffset = 0;
	private lastPreviewHeight = 0;
	private previewCache: { entryId: string; width: number; bodyLines: string[]; truncatedToMaxLines: boolean } | null = null;
	private _focused = false;
	/** Whether the cursor's own row survived the last composition; selection is refused when it did not */
	private focusedRowVisible = false;
	/** Set when the upstream component's shape changes mid-session; the overlay then only accepts Esc */
	private compatibilityError: BoundaryPickerCompatibilityError | null = null;
	/** Where the selector's tree rows sit inside its rendered output, recorded by the render patch */
	private treeRegion: { firstLine: string | null; count: number; focusedOffset: number } = {
		firstLine: null,
		count: 0,
		focusedOffset: -1,
	};

	constructor(
		private readonly selector: TreeSelectorComponent,
		private readonly model: BoundaryPickerModel,
		private readonly internals: TreeListInternals,
		private readonly nodeById: Map<string, ToolHorizonTreeNode>,
		private readonly getTermHeight: () => number,
		private readonly requestRender: () => void,
		private readonly cancel: () => void,
		private readonly theme: BoundaryPickerThemeLike,
	) {}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.selector.focused = value;
	}

	/** Records where the decorated tree rows landed, so composition can protect the focused one */
	recordTreeRegion(firstLine: string | null, count: number, focusedOffset: number): void {
		this.treeRegion = { firstLine, count, focusedOffset };
	}

	/** Enters the terminal incompatibility state: nothing is selectable and only Esc is accepted */
	reportCompatibilityFailure(error: BoundaryPickerCompatibilityError): void {
		this.compatibilityError = error;
	}

	/** Called by the selector's onSelect; returns a selection to commit, or null to stay open */
	handleEntrySelection(entryId: string): BoundaryPickerSelection | null {
		if (this.compatibilityError) return null;
		// Committing a boundary whose row was squeezed off a short terminal would hide what is about to
		// be pruned behind an invisible cursor.
		if (!this.focusedRowVisible) {
			this.flash("Terminal too short to show the session tree — resize to choose a horizon", "warning");
			return null;
		}
		const resolved = resolveBoundarySelection(this.model, entryId);
		if (resolved.ok) return resolved.selection;

		this.flash(
			resolved.row === null
				? "This row is not part of the picker model"
				: describeUnavailableReason(resolved.row.reason),
			"warning",
		);
		return null;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		// Once the upstream shape no longer matches, availability and reclaim can no longer be trusted,
		// so the only thing left to do is leave. Cancel goes straight out rather than through the
		// selector, whose first Esc would only clear an active search.
		if (this.compatibilityError) {
			if (keybindings.matches(data, "tui.select.cancel")) this.cancel();
			return;
		}
		// Labels, label timestamps, and copy are native selector actions with no meaning here. They
		// must be swallowed before reaching the selector, which would otherwise act on them.
		for (const blocked of BLOCKED_SELECTOR_ACTIONS) {
			if (keybindings.matches(data, blocked)) {
				this.flash("Unavailable in the horizon picker", "warning");
				return;
			}
		}

		if (this.matchesPreviewScroll(data)) return;

		this.selector.handleInput(data);
		this.requestRender();
	}

	private matchesPreviewScroll(data: string): boolean {
		const page = Math.max(1, (this.lastPreviewHeight > 0 ? this.lastPreviewHeight : 10) - 1);
		const delta = matchesKey(data, "shift+up")
			? -1
			: matchesKey(data, "shift+down")
				? 1
				: matchesKey(data, "shift+pageUp")
					? -page
					: matchesKey(data, "shift+pageDown")
						? page
						: null;
		if (delta === null) return false;
		this.previewScrollOffset += delta;
		this.requestRender();
		return true;
	}

	private flash(text: string, tone: "warning" | "error"): void {
		this.flashMessage = { text, tone };
		if (this.flashTimer) clearTimeout(this.flashTimer);
		this.flashTimer = setTimeout(() => {
			this.flashMessage = null;
			this.flashTimer = null;
			this.requestRender();
		}, FLASH_DURATION_MS);
		this.requestRender();
	}

	invalidate(): void {
		this.previewCache = null;
		this.previewScrollOffset = 0;
		this.lastPreviewHeight = 0;
		this.selector.invalidate();
	}

	private renderStatus(width: number): string[] {
		const focused = (this.selector.getTreeList() as unknown as TreeListLike).getSelectedNode();
		const row = focused ? this.model.rowsByEntryId.get(focused.entry.id) ?? null : null;
		const boundaryId = this.model.currentBoundaryEntryId;
		return renderBoundaryPickerStatusLines({
			row,
			currentBoundaryMode: this.model.currentBoundaryMode,
			currentBoundaryHidden: boundaryId !== null && !this.isEntryVisible(boundaryId),
			flash: this.flashMessage,
			width,
			theme: this.theme,
		});
	}

	/** Safe because the render patch validates every filtered node's shape earlier in the same pass */
	private isEntryVisible(entryId: string): boolean {
		return this.internals.filteredNodes.some((item) => item.node.entry.id === entryId);
	}

	private renderPreview(width: number, height: number): string[] {
		if (height <= 0) return [];
		// A rule only earns its row when there is a preview under it.
		if (height >= 3) {
			const rule = truncateToWidth(this.theme.fg("dim", "─".repeat(width)), width);
			return [rule, ...this.renderPreviewBody(width, height - 1)];
		}
		return this.renderPreviewBody(width, height);
	}

	private renderPreviewBody(width: number, height: number): string[] {
		if (height <= 0) return [];
		this.lastPreviewHeight = height;

		const focused = (this.selector.getTreeList() as unknown as TreeListLike).getSelectedNode();
		if (!focused) return Array.from({ length: height }, () => "");

		const entryId = focused.entry.id;
		if (!this.previewCache || this.previewCache.entryId !== entryId || this.previewCache.width !== width) {
			const rendered = renderPreviewBody({ entry: focused.entry, nodeById: this.nodeById, width, theme: this.theme });
			this.previewCache = {
				entryId,
				width,
				bodyLines: rendered.slice(0, MAX_PREVIEW_LINES),
				truncatedToMaxLines: rendered.length > MAX_PREVIEW_LINES,
			};
			this.previewScrollOffset = 0;
		}

		const clamped = clampPreviewWindow({
			bodyLines: this.previewCache.bodyLines,
			height,
			offset: this.previewScrollOffset,
			truncatedToMaxLines: this.previewCache.truncatedToMaxLines,
			theme: this.theme,
			width,
		});
		this.previewScrollOffset = clamped.offset;
		return clamped.lines;
	}

	private hasCompatibilityError(): boolean {
		return this.compatibilityError !== null;
	}

	private renderCompatibilityPanel(width: number, height: number): string[] {
		this.focusedRowVisible = false;
		return [
			"",
			truncateToWidth(this.theme.fg("error", `  ${this.compatibilityError?.message ?? ""}`), width),
			truncateToWidth(this.theme.fg("dim", "  No horizon can be chosen safely. Esc to close."), width),
		].slice(0, Math.max(1, height));
	}

	render(width: number): string[] {
		const height = this.getTermHeight();
		if (this.compatibilityError) return this.renderCompatibilityPanel(width, height);

		const selectorLines = this.selector.render(width);
		// The patched tree render runs inside the call above, so a shape mismatch is known now. Nothing
		// downstream (status, visibility checks, preview) may touch internals whose invariants just failed.
		if (this.hasCompatibilityError()) return this.renderCompatibilityPanel(width, height);

		// The render patch just ran (inside selector.render), so treeRegion describes this very pass. A
		// first line that cannot be located leaves the region empty, which refuses selection rather than
		// guessing where the rows are.
		const treeStart = this.treeRegion.firstLine === null ? -1 : selectorLines.indexOf(this.treeRegion.firstLine);
		const composed = composeOverlayLines({
			selectorLines,
			treeRegion:
				treeStart < 0
					? { start: selectorLines.length, count: 0, focusedOffset: -1 }
					: { start: treeStart, count: this.treeRegion.count, focusedOffset: this.treeRegion.focusedOffset },
			statusLines: this.renderStatus(width),
			renderPreview: (previewHeight) => this.renderPreview(width, previewHeight),
			height,
		});
		this.focusedRowVisible = composed.focusedRowVisible;
		return composed.lines;
	}

	dispose(): void {
		if (this.flashTimer) {
			clearTimeout(this.flashTimer);
			this.flashTimer = null;
		}
		this.previewCache = null;
		this.previewScrollOffset = 0;
		this.lastPreviewHeight = 0;
		this.nodeById.clear();
	}
}

/**
 * Open the boundary picker overlay and resolve with the chosen boundary
 *
 * Args:
 *     ctx (ExtensionContext): extension context providing the custom-UI surface
 *     request: the full session tree (for preview parent links), the current leaf, and the model
 *
 * Returns:
 *     The selected boundary, or null when the user cancels
 *
 * Raises:
 *     BoundaryPickerCompatibilityError: if the upstream tree component's internals changed shape
 */
export async function showToolHorizonBoundaryPicker(
	ctx: ExtensionContext,
	request: {
		fullTree: readonly ToolHorizonTreeNode[];
		currentLeafId: string | null;
		model: BoundaryPickerModel;
	},
): Promise<BoundaryPickerSelection | null> {
	return ctx.ui.custom<BoundaryPickerSelection | null>((tui, theme, _kb, done) => {
		const termRows = tui.terminal.rows;
		const nodeById = buildNodeMap(request.fullTree);

		// The selector is constructed before the overlay exists, so route selection through a holder
		// that the overlay fills in immediately afterwards.
		const selectionHandler: { handle: ((entryId: string) => BoundaryPickerSelection | null) | null } = { handle: null };

		const selector = new TreeSelectorComponent(
			request.model.displayedTree as never,
			request.currentLeafId,
			Math.floor(termRows * SELECTOR_HEIGHT_RATIO),
			(entryId: string) => {
				const selection = selectionHandler.handle?.(entryId) ?? null;
				if (selection) done(selection);
			},
			() => done(null),
			undefined,
			request.model.initialSelectedId,
			INITIAL_FILTER_MODE,
		);

		// Validate the upstream internals before anything else is wired: a synchronous throw here rejects
		// the promise returned by ctx.ui.custom (the factory runs inside its Promise executor), so the
		// picker fails closed instead of presenting a tree with no availability or estimate information.
		const treeList = selector.getTreeList() as unknown as TreeListLike;
		const internals = readTreeListInternals(treeList);
		replaceNativeHelpRow(selector, new BoundaryPickerHelp(theme as BoundaryPickerThemeLike));

		const overlay = new BoundaryPickerOverlay(
			selector,
			request.model,
			internals,
			nodeById,
			() => tui.terminal.rows,
			() => tui.requestRender(),
			() => done(null),
			theme as BoundaryPickerThemeLike,
		);
		selectionHandler.handle = (entryId) => overlay.handleEntrySelection(entryId);
		const originalRender = treeList.render.bind(treeList);
		treeList.render = (width: number) => {
			const innerWidth = Math.max(MIN_INNER_WIDTH, width - OVERLAY_HORIZONTAL_CHROME);
			const rendered = originalRender(innerWidth);
			try {
				const decorated = decorateTreeRows({
					lines: rendered,
					filteredNodes: internals.filteredNodes,
					selectedIndex: internals.selectedIndex,
					maxVisibleLines: internals.maxVisibleLines,
					width,
					rowsByEntryId: request.model.rowsByEntryId,
					theme: theme as BoundaryPickerThemeLike,
				});
				// The trailing line is the component's own status line, never a selectable entry.
				const rowCount = internals.filteredNodes.length === 0 ? 0 : Math.max(0, decorated.length - 1);
				const windowStart = computeVisibleWindowStart({
					selectedIndex: internals.selectedIndex,
					maxVisibleLines: Math.max(1, internals.maxVisibleLines),
					filteredNodeCount: internals.filteredNodes.length,
				});
				overlay.recordTreeRegion(
					rowCount > 0 ? decorated[0] : null,
					rowCount,
					rowCount > 0 ? internals.selectedIndex - windowStart : -1,
				);
				return decorated;
			} catch (error) {
				// Throwing out of a render pass would take down the TUI; the overlay instead switches to an
				// explicit incompatibility state where nothing is selectable.
				if (!(error instanceof BoundaryPickerCompatibilityError)) throw error;
				overlay.recordTreeRegion(null, 0, -1);
				overlay.reportCompatibilityFailure(error);
				return [];
			}
		};

		tui.setFocus(overlay);
		return overlay;
	});
}
