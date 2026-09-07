import type { EventBus, ExtensionContext, ToolExecutionUpdateEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const FileActionSchema = Type.Union([
	Type.Object({ kind: Type.Literal("touch"), path: Type.String({ minLength: 1 }), operation: Type.Union([
		Type.Literal("read"), Type.Literal("write"), Type.Literal("edit"), Type.Literal("create"), Type.Literal("delete"),
	]) }),
	Type.Object({ kind: Type.Literal("move"), from: Type.String({ minLength: 1 }), to: Type.String({ minLength: 1 }) }),
]);
export type FileAction = Static<typeof FileActionSchema>;

export const FileEvidenceSchema = Type.Object({
	version: Type.Literal(1),
	calls: Type.Array(Type.Object({ toolCallId: Type.String(), actions: Type.Array(FileActionSchema) })),
	incomplete: Type.Boolean(),
});
export type FileEvidence = Static<typeof FileEvidenceSchema>;

export const PatchArgumentsSchema = Type.Object({ input: Type.String() });
export const CommandArgumentsSchema = Type.Object({ cmd: Type.String(), workdir: Type.Optional(Type.String()) });
export const BashArgumentsSchema = Type.Object({ command: Type.String() });
export const OperationCallSchema = Type.Union([
	Type.Object({ toolName: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("edit")]),
		toolArguments: Type.Object({ path: Type.String() }) }),
	Type.Object({ toolName: Type.Literal("rp_exec"), toolArguments: Type.Object({ cmd: Type.String() }) }),
	Type.Object({ toolName: Type.Literal("rp"), toolArguments: Type.Union([
		Type.Object({ call: Type.Union([Type.Literal("read_file"), Type.Literal("apply_edits")]),
			args: Type.Object({ path: Type.String() }) }),
		Type.Object({ call: Type.Literal("file_actions"), args: Type.Union([
			Type.Object({ action: Type.Union([Type.Literal("create"), Type.Literal("delete")]), path: Type.String() }),
			Type.Object({ action: Type.Literal("move"), path: Type.String(), new_path: Type.String() }),
		]) }),
	]) }),
]);

/** `FileCallParser` converts raw tool arguments into file operations before attribution. */
export type IncomingFileCall = { toolName: string; toolArguments: unknown };
export type FileCallResult = { content: unknown; details: unknown; isError: boolean };
export type CompletedFileCall = IncomingFileCall & { toolResult: FileCallResult; cwd: string | null | undefined };
/** `incomplete` marks a known gap in the available tool evidence. */
export type ParsedFileActions = { actions: FileAction[]; incomplete: boolean };
export type FileCallParser = (call: CompletedFileCall) => ParsedFileActions;

export const NestedCompletionSchema = Type.Object({
	toolName: Type.String(), toolCallId: Type.String(), cwd: Type.String(), input: Type.Unknown(),
	status: Type.Union([Type.Literal("success"), Type.Literal("error")]), result: Type.Unknown(),
});
export type NestedCompletion = Static<typeof NestedCompletionSchema>;

export type FileTrackingContext = Pick<ExtensionContext, "hasUI"> & { ui: Pick<ExtensionContext["ui"], "notify"> };
export type ResultEnvelope = { details: unknown };
export type FileTrackingHandlers = {
	tool_execution_update: (event: Pick<ToolExecutionUpdateEvent, "toolName" | "toolCallId"> & { partialResult: ResultEnvelope }) => void;
	tool_result: (event: Pick<ToolResultEvent, "toolName" | "toolCallId" | "details" | "isError"> & { input: unknown },
		ctx: FileTrackingContext) => { details: { filesTouched: FileEvidence } } | void;
	session_start: () => void;
	session_tree: () => void;
	session_shutdown: () => void;
};

/** Limits the recorder to lifecycle events and result annotations. */
export type FileTrackingHost = {
	events: EventBus;
	on<K extends keyof FileTrackingHandlers>(event: K, handler: FileTrackingHandlers[K]): void;
};
