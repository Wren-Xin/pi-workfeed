#!/usr/bin/env node
/**
 * Item ids are join keys: `clear` must not hand out `#1` again inside one session.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

// The extensions import values from pi's host packages, which are peer dependencies of
// the *host*, not of this package. Without this hook the suite needs an installed pi and
// fails in a fresh clone or CI.
register("./stubs/pi-loader.mjs", import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..", "extensions");
process.env.PI_WORKFEED_DIR = mkdtempSync(join(tmpdir(), "workfeed-ids-"));

const bus = new Map();
const pi = {
	handlers: new Map(),
	tools: [],
	commands: [],
	entries: [],
	on(n, f) { this.handlers.set(n, f); },
	registerTool(d) { this.tools.push(d); },
	registerCommand() {},
	appendEntry(t, d) { this.entries.push({ t, d }); },
	events: { on(n, f) { bus.set(n, f); }, emit(n, d) { bus.get(n)?.(d); } },
};
const ctx = {
	hasUI: false,
	cwd: "D:\\demo",
	model: { id: "qwen3-demo", provider: "local-vllm" },
	sessionManager: { getSessionId: () => "sid-ids", getBranch: () => [], getEntries: () => [], getSessionFile: () => "" },
	ui: { setStatus() {}, notify() {} },
};

const todoMod = await import(pathToFileURL(join(ext, "todo", "index.ts")).href);
todoMod.default(pi);
await pi.handlers.get("session_start")({ reason: "startup" }, ctx);

const run = (args) => pi.tools[0].execute("c", args, undefined, undefined, ctx);
await run({ action: "write", todos: [{ text: "first list item", status: "in_progress" }] });
const first = pi.entries.at(-1).d;
await run({ action: "clear" });
const cleared = pi.entries.at(-1).d;
await run({ action: "write", todos: [{ text: "second list item", status: "pending" }] });
const second = pi.entries.at(-1).d;

console.log(`first ids: [${first.todos.map((t) => t.id).join(",")}] nextId=${first.nextId}`);
console.log(`after clear: ${cleared.todos.length} items, nextId=${cleared.nextId}`);
console.log(`second ids: [${second.todos.map((t) => t.id).join(",")}] nextId=${second.nextId}`);

const ok = second.todos[0].id === 2 && cleared.nextId === 2 && !first.todos.some((t) => second.todos.some((s) => s.id === t.id));
console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(ok ? 0 : 1);
