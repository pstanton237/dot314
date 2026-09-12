import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { parse } from "just-bash";

export type PermissionAction = "allow" | "ask" | "deny" | "reject";

export interface AmpPermission {
	tool: string;
	matches?: { cmd?: string | string[] };
	action: PermissionAction;
}

interface AmpSettings {
	"amp.commands.allowlist"?: string[];
	"amp.permissions"?: AmpPermission[];
}

const READ_ONLY_COMMANDS = [
	"ls", "ls *", "dir", "dir *", "cat *", "head *", "tail *", "less *", "more *", "grep *", "egrep *",
	"fgrep *", "tree", "tree *", "file *", "wc *", "pwd", "stat *", "du *", "df *", "ps *", "top", "htop",
	"echo *", "printenv *", "id", "which *", "whereis *", "date", "cal *", "uptime", "free *", "ping *", "dig *",
	"nslookup *", "host *", "netstat *", "ss *", "lsof *", "ifconfig *", "ip *", "man *", "info *", "mkdir *",
	"touch *", "uname *", "whoami", "go version", "go env *", "go help *", "cargo version", "cargo --version",
	"cargo help *", "rustc --version", "rustc --help", "rustc --explain *", "javac --version", "javac -version",
	"javac -help", "javac --help", "dotnet --info", "dotnet --version", "dotnet --help", "dotnet help *",
	"gcc --version", "gcc -v", "gcc --help", "gcc -dumpversion", "g++ --version", "g++ -v", "g++ --help",
	"g++ -dumpversion", "clang --version", "clang --help", "clang++ --version", "clang++ --help", "python -V",
	"python --version", "python -h", "python --help", "python3 -V", "python3 --version", "python3 -h", "python3 --help",
	"ruby -v", "ruby --version", "ruby -h", "ruby --help", "node -v", "node --version", "node -h", "node --help",
	"npm --help", "npm --version", "npm -v", "npm help *", "yarn --help", "yarn --version", "yarn -v", "yarn help *",
	"pnpm --help", "pnpm --version", "pnpm -v", "pnpm help *", "pytest -h", "pytest --help", "pytest --version",
	"jest --help", "jest --version", "mocha --help", "mocha --version", "make --version", "make --help",
	"docker --version", "docker --help", "docker version", "docker help *", "git --version", "git --help", "git help *",
	"git version",
];

const DEVELOPMENT_COMMANDS = [
	"go test *", "go run *", "go build *", "go vet *", "go fmt *", "go list *", "cargo test *", "cargo run *",
	"cargo build *", "cargo check *", "cargo fmt *", "cargo tree *", "make -n *", "make --dry-run *", "mvn test *",
	"mvn verify *", "mvn dependency:tree *", "gradle tasks *", "gradle dependencies *", "gradle properties *",
	"dotnet test *", "dotnet list *", "python -c *", "ruby -e *", "node -e *", "npm list *", "npm ls *",
	"npm outdated *", "npm test*", "npm run*", "npm view *", "npm info *", "yarn list*", "yarn ls *", "yarn info *",
	"yarn test*", "yarn run *", "yarn why *", "pnpm list*", "pnpm ls *", "pnpm outdated *", "pnpm test*",
	"pnpm run *", "pytest --collect-only *", "jest --listTests *", "jest --showConfig *", "mocha --list *",
	"git status*", "git show *", "git diff*", "git grep *", "git branch *", "git tag *", "git remote -v *",
	"git rev-parse --is-inside-work-tree *", "git rev-parse --show-toplevel *", "git config --list *", "git log *",
	"./gradlew *", "./mvnw *", "./build.sh *", "./configure *", "cmake *", "./node_modules/.bin/tsc *",
	"./node_modules/.bin/eslint *", "./node_modules/.bin/prettier *", "prettier *",
	"./node_modules/.bin/tailwindcss *", "./node_modules/.bin/tsx *", "./node_modules/.bin/vite *", "bun *", "tsx *",
	"vite *", ".venv/bin/activate *", ".venv/Scripts/activate *", "source .venv/bin/activate *",
	"source venv/bin/activate *", "pip list *", "pip show *", "pip check *", "pip freeze *", "uv *", "poetry show *",
	"poetry check *", "pipenv check *", "asdf list *", "asdf current *", "asdf which *", "mise list *", "mise current *",
	"mise which *", "mise use *", "rbenv version *", "rbenv versions *", "rbenv which *", "nvm list *", "nvm current *",
	"nvm which *", "./test*", "./run_tests.sh *", "./run_*_tests.sh *", "vitest *", "bundle exec rspec *",
	"bundle exec rubocop *", "rspec *", "rubocop *", "swiftlint *", "clippy *", "ruff *", "black *", "isort *",
	"mypy *", "flake8 *", "bandit *", "safety *", "biome check *", "biome format *", "rails server *", "rails s *",
	"bin/rails server *", "bin/rails s *", "flask run *", "django-admin runserver *", "python manage.py runserver *",
	"uvicorn *", "streamlit run *", "bin/rails db:status", "bin/rails db:version", "rails db:rollback *",
	"rails db:status *", "rails db:version *", "alembic current *", "alembic history *", "bundle exec rails db:status",
	"bundle exec rails db:version", "docker ps *", "docker images *", "docker logs *", "docker inspect *", "docker info *",
	"docker stats *", "docker system df *", "docker system info *", "podman ps *", "podman images *", "podman logs *",
	"podman inspect *", "podman info *", "aws --version *", "aws configure list *", "aws sts get-caller-identity *",
	"aws s3 ls *", "gcloud config list *", "gcloud auth list *", "gcloud projects list *", "az account list *",
	"az account show *", "kubectl get *", "kubectl describe *", "kubectl logs *", "kubectl version *", "helm list *",
	"helm status *", "helm version *", "swift build *", "swift test *", "zig build *", "zig build test*", "kotlinc *",
	"scalac *", "javac *", "javap *", "clang *", "jar *", "sbt *", "gradle *", "bazel build *", "bazel test *",
	"bazel run *", "mix *", "lua *", "ruby *", "php *", "mkdir -p *", "chmod +x *", "dos2unix *", "unix2dos *",
	"ln -s *",
];

export const BUILTIN_PERMISSIONS: AmpPermission[] = [
	{ tool: "Bash", action: "ask", matches: { cmd: "*git*push*" } },
	{ tool: "Bash", action: "allow", matches: { cmd: READ_ONLY_COMMANDS } },
	{ tool: "Bash", action: "allow", matches: { cmd: DEVELOPMENT_COMMANDS } },
	{
		tool: "Bash",
		action: "ask",
		matches: {
			cmd: [
				"for *", "while *", "do *", "done *", "if *", "then *", "else *", "elif *", "fi *", "case *",
				"esac *", "in *", "function *", "select *", "until *", "{ *", "} *", "[[ *", "]] *",
			],
		},
	},
	{ tool: "Bash", action: "allow", matches: { cmd: "/^find(?!.*(-delete|-exec|-execdir)).*$/" } },
	{
		tool: "Bash",
		action: "allow",
		matches: { cmd: "/^(echo|ls|pwd|date|whoami|id|uname)\\s.*[&|;].*\\s*(echo|ls|pwd|date|whoami|id|uname)($|\\s.*)/" },
	},
	{
		tool: "Bash",
		action: "allow",
		matches: {
			cmd: "/^(cat|grep|head|tail|less|more|find)\\s.*\\|\\s*(grep|head|tail|less|more|wc|sort|uniq)($|\\s.*)/",
		},
	},
	{
		tool: "Bash",
		action: "ask",
		matches: { cmd: "/^rm\\s+.*(-[rf].*-[rf]|-[rf]{2,}|--recursive.*--force|--force.*--recursive).*$/" },
	},
	{ tool: "Bash", action: "ask", matches: { cmd: "/^find.*(-delete|-exec|-execdir).*$/" } },
	{ tool: "Bash", action: "allow", matches: { cmd: "/^(ls|cat|grep|head|tail|file|stat)\\s+[^/]*$/" } },
	{
		tool: "Bash",
		action: "allow",
		matches: { cmd: "/^(?!.*(rm|mv|cp|chmod|chown|sudo|su|dd)\\b).*\/dev\/(null|zero|stdout|stderr|stdin).*$/" },
	},
	{ tool: "Bash", action: "ask" },
];

export const CD_PREFIX_RE = /^cd[^;&]*?&&\s*/;
export const GLOBAL_SETTINGS = join(homedir(), ".config", "amp", "settings.json");
export const AMPLIKE_SETTINGS_PATH = join(resolveAgentDir(), "amplike.json");

export function resolveAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return configured;
}

export interface AmplikeSettings {
	permissions?: { mode?: "enabled" | "yolo" };
	subagent?: { extensions?: string[] };
}

export function loadSettings(paths: string[]): AmpSettings {
	const merged: AmpSettings = {};
	for (const settingsPath of paths) {
		try {
			const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as AmpSettings;
			if (settings["amp.commands.allowlist"]) {
				merged["amp.commands.allowlist"] = [
					...(merged["amp.commands.allowlist"] ?? []),
					...settings["amp.commands.allowlist"],
				];
			}
			if (settings["amp.permissions"]) {
				merged["amp.permissions"] = [
					...(merged["amp.permissions"] ?? []),
					...settings["amp.permissions"],
				];
			}
		} catch {
			// Missing or invalid settings files do not contribute rules
		}
	}
	return merged;
}

export function getBaseCommand(command: string): string {
	return command.trim().replace(CD_PREFIX_RE, "").trim().split(/\s+/)[0] ?? "";
}

function globToRegex(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

export function matchesCmd(pattern: string | string[], command: string): boolean {
	if (Array.isArray(pattern)) return pattern.some((candidate) => matchesCmd(candidate, command));
	if (pattern === "*") return true;
	const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
	if (regexMatch) {
		try {
			return new RegExp(regexMatch[1], regexMatch[2]).test(command);
		} catch {
			return false;
		}
	}
	return globToRegex(pattern).test(command);
}

export function ruleAppliesToBash(rule: AmpPermission): boolean {
	if (rule.tool === "Bash" || rule.tool === "*") return true;
	try {
		return globToRegex(rule.tool).test("Bash");
	} catch {
		return false;
	}
}

export function loadAmplikeSettings(): AmplikeSettings {
	try {
		return JSON.parse(readFileSync(AMPLIKE_SETTINGS_PATH, "utf8")) as AmplikeSettings;
	} catch {
		return {};
	}
}

export function saveAmplikeSettings(settings: AmplikeSettings): void {
	mkdirSync(dirname(AMPLIKE_SETTINGS_PATH), { recursive: true });
	const temporaryPath = `${AMPLIKE_SETTINGS_PATH}.tmp.${process.pid}`;
	writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, AMPLIKE_SETTINGS_PATH);
}

function normalizeAction(action: unknown): PermissionAction {
	return action === "allow" || action === "deny" || action === "reject" || action === "ask" ? action : "ask";
}

function wordToText(word: any): string | undefined {
	if (!word || typeof word !== "object" || !Array.isArray(word.parts)) return undefined;
	const parts: string[] = [];
	for (const part of word.parts) {
		if (!part || typeof part !== "object") return undefined;
		if (part.type === "Literal" || part.type === "SingleQuoted" || part.type === "Escaped") {
			if (typeof part.value !== "string") return undefined;
			parts.push(part.value);
			continue;
		}
		if (part.type === "DoubleQuoted") {
			const value = wordToText(part);
			if (value === undefined) return undefined;
			parts.push(value);
			continue;
		}
		if (part.type === "Glob" && typeof part.pattern === "string") {
			parts.push(part.pattern);
			continue;
		}
		if (part.type === "TildeExpansion") {
			parts.push(typeof part.user === "string" && part.user ? `~${part.user}` : "~");
			continue;
		}
		return undefined;
	}
	return parts.join("");
}

function parseSimpleCommands(command: string): string[] | undefined {
	try {
		const ast: any = parse(command);
		if (!ast || !Array.isArray(ast.statements)) return undefined;
		const commands: string[] = [];
		for (const statement of ast.statements) {
			if (!statement || !Array.isArray(statement.pipelines)) return undefined;
			for (const pipeline of statement.pipelines) {
				if (!pipeline || !Array.isArray(pipeline.commands)) return undefined;
				for (const commandNode of pipeline.commands) {
					if (commandNode?.type !== "SimpleCommand") return undefined;
					const name = wordToText(commandNode.name);
					if (!name) return undefined;
					const args: string[] = [];
					for (const arg of commandNode.args ?? []) {
						const value = wordToText(arg);
						if (value === undefined) return undefined;
						args.push(value);
					}
					if (name === "cd") continue;
					commands.push([name, ...args].join(" "));
				}
			}
		}
		return commands.length > 0 ? commands : undefined;
	} catch {
		return undefined;
	}
}

function resolveSimpleBashAction(command: string, cwd: string): PermissionAction {
	const strippedCommand = command.trim();
	const settings = loadSettings([GLOBAL_SETTINGS, resolve(cwd, ".agents", "settings.json")]);
	const allowlist = settings["amp.commands.allowlist"] ?? [];
	const userRules = settings["amp.permissions"] ?? [];
	const baseCommand = getBaseCommand(command);
	const applyRules = (rules: AmpPermission[]): PermissionAction | undefined => {
		for (const rule of rules) {
			if (!ruleAppliesToBash(rule)) continue;
			const commandPattern = rule.matches?.cmd;
			if (commandPattern !== undefined && !matchesCmd(commandPattern, strippedCommand)) continue;
			return normalizeAction(rule.action);
		}
		return undefined;
	};
	const userAction = applyRules(userRules);
	if (userAction !== undefined) return userAction;
	if (allowlist.includes(baseCommand)) return "allow";
	return applyRules(BUILTIN_PERMISSIONS) ?? "allow";
}

export function resolveBashAction(command: string, cwd: string): PermissionAction {
	const commands = parseSimpleCommands(command.trim().replace(CD_PREFIX_RE, ""));
	if (!commands) return "ask";
	const actions = commands.map((simpleCommand) => resolveSimpleBashAction(simpleCommand, cwd));
	if (actions.includes("deny")) return "deny";
	if (actions.includes("reject")) return "reject";
	if (actions.includes("ask")) return "ask";
	return "allow";
}
