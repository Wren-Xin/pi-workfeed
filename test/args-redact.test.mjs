#!/usr/bin/env node
/**
 * Redaction covers the argument channel for *unknown* tools (MCP, other extensions),
 * in both the per-tool fallback (`redacted`, the default) and `full`.
 *
 * Run twice (see test/run.mjs): once with the default, once with PI_WORKFEED_ARGS=full.
 */
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

register("./stubs/pi-loader.mjs", import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..", "extensions");
const MODE = process.env.PI_WORKFEED_ARGS;
const ROOT = mkdtempSync(join(tmpdir(), "workfeed-redact-"));
process.env.PI_WORKFEED_DIR = ROOT;
process.env.PI_WORKFEED_CONTENT = "1";

const bus = new Map();
const pi = {
	handlers: new Map(),
	tools: [],
	commands: [],
	entries: [],
	on(n, f) { this.handlers.set(n, f); },
	registerTool() {},
	registerCommand() {},
	appendEntry() {},
	events: { on(n, f) { bus.set(n, f); }, emit(n, d) { bus.get(n)?.(d); } },
};
const ctx = {
	hasUI: false,
	cwd: "D:\\demo",
	model: { id: "qwen3-demo", provider: "local-vllm" },
	sessionManager: { getSessionId: () => "sid-redact", getBranch: () => [], getEntries: () => [], getSessionFile: () => "" },
	ui: { setStatus() {}, notify() {} },
};

const journalMod = await import(pathToFileURL(join(ext, "journal", "index.ts")).href);
journalMod.default(pi);
await pi.handlers.get("session_start")({ reason: "startup" }, ctx);

const SECRETS = {
	password: "hunter2pw",
	dsn: "postgres://admin:hunter2pw@db.internal:5432/prod",
	aws: "AKIAIOSFODNN7EXAMPLE",
	jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
	env: "DATABASE_URL=postgres://admin:hunter2pw@db.internal:5432/prod",
	curl: "curl -u admin:hunter2pw https://api.example.com",
	header: "Authorization: Bearer abcdef1234567890xyz",
	keyflag: "--token hunter2pw",
};

await pi.handlers.get("tool_call")(
	{
		toolCallId: "m1",
		toolName: "mcp__filesystem__read_text_file",
		input: { path: "C:\\work\\app.env", conn: SECRETS.dsn, awsKey: SECRETS.aws, idToken: SECRETS.jwt, note: SECRETS.env, sh: SECRETS.curl, hdr: SECRETS.header, cli: SECRETS.keyflag },
	},
	ctx,
);
await pi.handlers.get("tool_execution_end")({ toolCallId: "m1", toolName: "mcp__filesystem__read_text_file", durationMs: 10, isError: false, result: { content: [] } }, ctx);

const dir = join(ROOT, readdirSync(ROOT)[0]);
const raw = readFileSync(join(dir, "workfeed-sid-redact.jsonl"), "utf8");
const leaks = Object.entries(SECRETS).filter(([, v]) => raw.includes(v));
console.log(`mode=${MODE || "redacted (default)"} | args leaked: ${leaks.length ? leaks.map(([k]) => k).join(",") : "none"}`);
console.log(leaks.length === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(leaks.length === 0 ? 0 : 1);
