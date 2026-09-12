import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
	getBaseCommand,
	matchesCmd,
	resolveBashAction,
	ruleAppliesToBash,
} from "../lib/permissions-core.js";

describe("permissions-core", () => {
	test("test_project_rule_takes_precedence_over_builtin_allow", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "btw-permissions-"));
		mkdirSync(join(cwd, ".agents"), { recursive: true });
		await Bun.write(join(cwd, ".agents", "settings.json"), JSON.stringify({
			"amp.permissions": [
				{ tool: "Bash", matches: { cmd: "git status*" }, action: "deny" },
			],
		}));
		expect(resolveBashAction("git status --short", cwd)).toBe("deny");
	});

	test("test_project_allowlist_precedes_builtin_default_ask", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "btw-permissions-"));
		mkdirSync(join(cwd, ".agents"), { recursive: true });
		await Bun.write(join(cwd, ".agents", "settings.json"), JSON.stringify({
			"amp.commands.allowlist": ["custom-check"],
		}));
		expect(resolveBashAction("cd /tmp && custom-check --all", cwd)).toBe("allow");
	});

	test("test_matching_supports_globs_regex_and_bash_tool_globs", () => {
		expect(matchesCmd("git diff*", "git diff --stat")).toBe(true);
		expect(matchesCmd("/^find(?!.*-delete).*$/", "find src -type f")).toBe(true);
		expect(ruleAppliesToBash({ tool: "B*", action: "allow" })).toBe(true);
		expect(getBaseCommand("cd /repo && bun test focused.test.ts")).toBe("bun");
	});

	test("test_compound_commands_require_every_invocation_to_be_allowed", () => {
		const cwd = mkdtempSync(join(tmpdir(), "btw-permissions-"));
		expect(resolveBashAction("git status --short && rm -rf /tmp/example", cwd)).toBe("ask");
		expect(resolveBashAction("cat README.md | rm -rf /tmp/example", cwd)).toBe("ask");
		expect(resolveBashAction("git status --short && git diff --stat", cwd)).toBe("allow");
	});
});
