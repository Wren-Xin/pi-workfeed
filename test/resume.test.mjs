#!/usr/bin/env node
/**
 * Session boundaries: restart, `/new`, midnight, and the ghost settle.
 *
 *   1. task numbering resumes from the log instead of restarting at 1
 *   2. a resumed session keeps one date directory, even across midnight
 *   3. `/new` in a live process starts a fresh session (task 1) with its own file
 *   4. `agent_settled` without a user prompt emits no settle row
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..", "extensions");

const ROOT = mkdtempSync(join(tmpdir(), "workfeed-resume-"));
process.env.PI_WORKFEED_DIR = ROOT;

const bus = new Map();
const makePi = () => ({
	handlers: new Map(),
	tools: [],
	commands: [],
	entries: [],
	on(n, f) {
		this.handlers.set(n, f);
	},
	registerTool(d) {
		this.tools.push(d);
	},
	registerCommand() {},
	appendEntry(t, d) {
		this.entries.push({ t, d });
	},
	events: { on(n, f) { bus.set(n, f); }, emit(n, d) { bus.get(n)?.(d); } },
});

const makeCtx = (sid) => ({
	hasUI: false,
	cwd: "D:\\demo",
	model: { id: "qwen3-demo", provider: "local-vllm" },
	thinkingLevel: "high",
	sessionManager: { getSessionId: () => sid, getSessionFile: () => `C:\\sessions\\${sid}.jsonl`, getBranch: () => [], getEntries: () => [] },
	ui: { setStatus() {}, notify() {} },
});

const journalMod = await import(pathToFileURL(join(ext, "journal", "index.ts")).href);

let fails = 0;
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) fails += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const boot = async (sid) => {
	const pi = makePi();
	journalMod.default(pi);
	const ctx = makeCtx(sid);
	await pi.handlers.get("session_start")({ reason: "startup" }, ctx);
	return { pi, ctx };
};
const prompt = async (s, ctx, text) => {
	await s.pi.handlers.get("before_agent_start")({ messageType: "user", prompt: text }, ctx);
	await s.pi.handlers.get("turn_start")({ turnIndex: 1 }, ctx);
	await s.pi.handlers.get("agent_settled")({ aborted: false });
};
const tasksIn = (logPath) =>
	readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.t === "settle").map((e) => e.task);

// ---- 1: two processes, one session, one log ----
const a1 = await boot("sid-resume");
await prompt(a1, a1.ctx, "task one");
const a2 = await boot("sid-resume");
await prompt(a2, a2.ctx, "task two");
const dirs = readdirSync(ROOT).filter((d) => !d.startsWith("."));
const dir = join(ROOT, dirs[0]);
const logPath = join(dir, "workfeed-sid-resume.jsonl");
check("one date dir only", dirs.length, 1);
check("task numbers resume", tasksIn(logPath), [1, 2]);
const digest = readFileSync(join(dir, "workfeed-sid-resume.digest.md"), "utf8");
check("two distinct task rows", digest.split("\n").filter((l) => /^\| \d+ \|/.test(l) && l.includes("| ok |")).length, 2);

// ---- 3: `/new` inside a live process ----
await a2.pi.handlers.get("session_start")({ reason: "new" }, makeCtx("sid-new"));
await prompt(a2, makeCtx("sid-new"), "fresh session");
check("new session starts at task 1", tasksIn(join(dir, "workfeed-sid-new.jsonl")), [1]);

// ---- 4: settle without a prompt ----
const b = await boot("sid-ghost");
await b.pi.handlers.get("agent_settled")({ aborted: false });
check("no ghost settle row", tasksIn(join(dir, "workfeed-sid-ghost.jsonl")), []);

// ---- 2: a log from an earlier day is reused ----
const dayDir = join(ROOT, "2026-11-09");
mkdirSync(dayDir, { recursive: true });
const oldLog = join(dayDir, "workfeed-sid-old.jsonl");
writeFileSync(
	oldLog,
	[
		{ v: 1, ts: 1, sid: "sid-old", task: 0, t: "session", reason: "startup", model: "qwen3-demo", cwd: "D:\\demo" },
		{ v: 1, ts: 2, sid: "sid-old", task: 1, t: "prompt", chars: 4 },
		{ v: 1, ts: 3, sid: "sid-old", task: 1, t: "settle", taskMs: 1000, turns: 1, tools: 0, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 0 } },
	].map((e) => JSON.stringify(e)).join("\n") + "\n",
	"utf8",
);
const c = await boot("sid-old");
await prompt(c, c.ctx, "after a day");
check("reused the old-day log", tasksIn(oldLog), [1, 2]);
check("no second file for the same sid", readdirSync(dir).filter((f) => f.includes("sid-old")).length, 0);

// ---- 5: the first log a session creates announces itself, exactly once ----
// A privacy policy only in the README is read by nobody who is already working; the notice
// has to fire when the writing starts, and firing twice per session would be noise.
const notices = [];
const uiCtx = {
	...makeCtx("sid-notice"),
	hasUI: true,
	ui: { setStatus() {}, notify(message, level) { notices.push({ message, level }); } },
};
const n = makePi();
journalMod.default(n);
await n.handlers.get("session_start")({ reason: "startup" }, uiCtx);
await n.handlers.get("session_start")({ reason: "startup" }, uiCtx);
check("startup notice: exactly one for a new log", notices.length, 1);
check("startup notice: names the log file", notices[0]?.message.includes("sid-notice"), true);
check("startup notice: names the off switch", notices[0]?.message.includes("PI_WORKFEED_CONTENT=0"), true);

// A log that already exists is not "new": reopening a session must stay quiet.
const quiet = [];
const quietCtx = { ...makeCtx("sid-resume"), hasUI: true, ui: { setStatus() {}, notify(m, l) { quiet.push({ m, l }); } } };
const q = makePi();
journalMod.default(q);
await q.handlers.get("session_start")({ reason: "startup" }, quietCtx);
check("startup notice: silent when resuming an existing log", quiet.length, 0);

console.log(fails === 0 ? "RESULT: PASS" : `RESULT: FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
