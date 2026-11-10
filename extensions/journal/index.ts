/**
 * pi-workfeed · journal — turns a pi session into a machine-readable event log.
 *
 * Two outputs, one truth, one derived:
 *   ~/.pi/agent/logs/<YYYY-MM-DD>/workfeed-<sid>.jsonl        真值层，一行一事件
 *   ~/.pi/agent/logs/<YYYY-MM-DD>/workfeed-<sid>.digest.md   派生层，聚合事实，可随时重算
 *
 * Every line carries the same four keys, so tasks / turns / tool calls / tokens
 * can be joined without guessing:
 *   v     schema version (1)
 *   sid   session id
 *   task  1-based user-instruction index
 *   item  todo id currently in_progress (absent when no task is active)
 *
 * Environment:
 *   PI_WORKFEED_DIR      log root (default ~/.pi/agent/logs)
 *   PI_WORKFEED_EXCERPT  tool-output excerpt bytes kept in the log (default 2048, 0 = keep none)
 *   PI_WORKFEED_CONTENT  set to 0 to record metadata only (no prompt text, no tool output)
 *   PI_WORKFEED_OFF=1    disable this extension
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildDigest, fmtDur, type TaskStats, type TodoItem, type ToolRecord, type TokenBuckets } from "./digest.ts";

const SCHEMA_VERSION = 1;

const EXCERPT = Math.max(0, Number(process.env.PI_WORKFEED_EXCERPT ?? 2048));
const CONTENT = process.env.PI_WORKFEED_CONTENT !== "0";
const ROOT = process.env.PI_WORKFEED_DIR || join(homedir(), ".pi", "agent", "logs");

const zeroTokens = (): TokenBuckets => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function dayStamp(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Serialize anything to something that will not break one-line JSON. */
function safeJson(value: unknown, max = 4000): unknown {
	let s: string;
	try {
		s = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	} catch {
		s = String(value);
	}
	return s.length <= max ? value : s.slice(0, max) + `…[${s.length - max} chars omitted]`;
}

/** Keep the head and the tail of a long output; the middle is rarely the signal. */
function excerpt(text: string): { out: string; bytes: number } {
	const bytes = Buffer.byteLength(text, "utf8");
	if (EXCERPT === 0 || bytes <= EXCERPT) return { out: EXCERPT === 0 ? "" : text, bytes };
	const half = Math.floor(EXCERPT / 2);
	return {
		out: `${text.slice(0, half)}\n…[${bytes - EXCERPT} bytes omitted]…\n${text.slice(-half)}`,
		bytes,
	};
}

/** Shrink tool arguments: never put a whole file body into the log. */
function slimArgs(name: string, input: unknown): unknown {
	const a = input as Record<string, unknown> | undefined;
	if (!a) return undefined;
	const clip = (v: unknown, n = 2000) => (typeof v === "string" ? v.slice(0, n) : v);
	switch (name) {
		case "bash":
		case "powershell":
			return { command: clip(a.command), timeout: a.timeout };
		case "write":
			return {
				path: a.path,
				contentBytes: typeof a.content === "string" ? Buffer.byteLength(a.content) : undefined,
			};
		case "edit":
			return {
				path: a.path,
				oldBytes: typeof a.old_string === "string" ? Buffer.byteLength(a.old_string) : undefined,
				newBytes: typeof a.new_string === "string" ? Buffer.byteLength(a.new_string) : undefined,
				replaceAll: a.replace_all,
			};
		case "read":
		case "ls":
			return { path: a.path, offset: a.offset, limit: a.limit };
		case "grep":
			return { pattern: a.pattern, path: a.path, glob: a.glob, output_mode: a.output_mode };
		default:
			return safeJson(a, 1200);
	}
}

function textOf(result: unknown): string {
	const r = result as { content?: Array<{ type?: string; text?: string }> } | undefined;
	if (!r?.content) return "";
	return r.content
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

function toTodoItems(snapshot: unknown): TodoItem[] {
	const s = snapshot as { todos?: Array<{ id?: number; text?: string; status?: string; elapsedMs?: number; startedAt?: number }> } | undefined;
	if (!s?.todos) return [];
	const now = Date.now();
	return s.todos.map((t, i) => {
		const base = t.elapsedMs ?? 0;
		const running = t.status === "in_progress" && t.startedAt ? base + Math.max(0, now - t.startedAt) : base;
		return { id: t.id ?? i + 1, text: String(t.text ?? ""), status: String(t.status ?? "pending"), elapsedMs: running };
	});
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_WORKFEED_OFF === "1") return;

	let sid = "unknown";
	let cwd = "";
	let dir: string | undefined;
	let logPath: string | undefined;
	let digestPath: string | undefined;
	let warned = false;

	let events = 0;
	let task = 0;
	let item: number | undefined;

	let taskStartTs = 0;
	let turns = 0;
	let tools = 0;
	let tokens = zeroTokens();
	let taskList: TaskStats[] = [];
	let toolRecords: ToolRecord[] = [];
	let todos: TodoItem[] = [];

	let turnStartTs = 0;
	let turnIndex = 0;
	let toolStarts = new Map<string, { name: string; ts: number }>();
	let currentTool: string | undefined;
	let lastTaskMs = 0;
	let taskCount = 0;

	let ticker: ReturnType<typeof setInterval> | undefined;
	let uiCtx: ExtensionContext | undefined;

	const write = (event: Record<string, unknown>) => {
		if (!logPath) return;
		events += 1;
		const line = JSON.stringify({ v: SCHEMA_VERSION, ts: Date.now(), sid, task, ...(item ? { item } : {}), ...event });
		try {
			appendFileSync(logPath, line + "\n", "utf8");
		} catch (err) {
			if (!warned) {
				warned = true;
				if (uiCtx?.hasUI) uiCtx.ui.notify(`workfeed: cannot write log: ${(err as Error).message}`, "error");
			}
		}
	};

	const ensureFiles = (ctx: ExtensionContext) => {
		if (logPath) return;
		try {
			dir = join(ROOT, dayStamp());
			mkdirSync(dir, { recursive: true });
			sid = ctx.sessionManager.getSessionId?.() || "unknown";
			cwd = ctx.cwd;
			logPath = join(dir, `workfeed-${sid}.jsonl`);
			digestPath = join(dir, `workfeed-${sid}.digest.md`);
		} catch {
			logPath = undefined;
		}
	};

	const writeDigest = () => {
		if (!digestPath) return;
		try {
			const md = buildDigest({
				sid,
				date: dayStamp(),
				generatedAt: Date.now(),
				model: uiCtx?.model?.id,
				provider: uiCtx?.model?.provider,
				cwd,
				events,
				tasks: taskList,
				tools: toolRecords,
				todos,
			});
			writeFileSync(digestPath, md, "utf8");
		} catch {
			/* derived data: failing to write it must never break the session */
		}
	};

	const status = (ctx: ExtensionContext | undefined, running: boolean) => {
		if (!ctx?.hasUI) return;
		if (!running) {
			ctx.ui.setStatus("workfeed", lastTaskMs ? `⏱ last ${fmtDur(lastTaskMs)}` : "");
			return;
		}
		const elapsed = taskStartTs ? Date.now() - taskStartTs : 0;
		const tail = currentTool ? ` · ${currentTool}` : "";
		const it = item ? ` · #${item}` : "";
		ctx.ui.setStatus("workfeed", `⏱ ${fmtDur(elapsed)}${tail}${it} · t${turnIndex} · ${tools} calls`);
	};

	const startTicker = (ctx: ExtensionContext) => {
		uiCtx = ctx;
		if (ticker || !ctx.hasUI) return;
		ticker = setInterval(() => {
			if (taskStartTs && uiCtx) status(uiCtx, true);
		}, 2000);
	};

	const stopTicker = () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	};

	// ---- todo state arrives from the todo extension over the shared bus ----
	// A `todo` line means "the list changed". Repeats are dropped here as well, so a
	// noisy publisher (UI tick, duplicate extension instance) cannot inflate the log.
	let lastTodoLine = "";
	pi.events.on("workfeed:todo", (snapshot: unknown) => {
		todos = toTodoItems(snapshot);
		const active = todos.find((t) => t.status === "in_progress");
		item = active?.id;
		const items = todos.map((t) => ({ id: t.id, status: t.status, elapsedMs: t.elapsedMs, text: t.text.slice(0, 120) }));
		const line = JSON.stringify(items);
		if (line === lastTodoLine) return;
		lastTodoLine = line;
		write({ t: "todo", rev: (snapshot as { rev?: number } | undefined)?.rev, items });
	});

	pi.on("session_start", async (event, ctx) => {
		ensureFiles(ctx);
		startTicker(ctx);
		write({
			t: "session",
			reason: (event as { reason?: string })?.reason,
			cwd,
			sessionFile: ctx.sessionManager.getSessionFile?.(),
			model: ctx.model?.id,
			provider: ctx.model?.provider,
			pid: process.pid,
		});
		writeDigest();
		status(ctx, false);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		write({
			t: "shutdown",
			reason: (event as { reason?: string })?.reason,
			turns,
			tools,
			tasks: taskCount,
			lastTaskMs,
		});
		writeDigest();
		stopTicker();
		if (ctx.hasUI) ctx.ui.setStatus("workfeed", "");
	});

	pi.on("before_agent_start", async (event, ctx) => {
		ensureFiles(ctx);
		const e = event as { messageType?: string; prompt?: string };
		if (e.messageType && e.messageType !== "user") return;
		task += 1;
		taskStartTs = Date.now();
		turns = 0;
		tools = 0;
		turnIndex = 0;
		tokens = zeroTokens();
		toolStarts = new Map();
		write({
			t: "prompt",
			chars: (e.prompt ?? "").length,
			...(CONTENT ? { text: (e.prompt ?? "").slice(0, 3000) } : {}),
			model: ctx.model?.id,
			thinking: ctx.thinkingLevel,
		});
		status(ctx, true);
	});

	pi.on("agent_start", async () => {
		write({ t: "agent_start" });
	});

	pi.on("turn_start", async (event, ctx) => {
		turnStartTs = Date.now();
		turnIndex = (event as { turnIndex?: number })?.turnIndex ?? turnIndex + 1;
		write({ t: "turn", phase: "start", turn: turnIndex, model: ctx.model?.id });
		status(ctx, true);
	});

	pi.on("turn_end", async (event, ctx) => {
		const e = event as {
			turnIndex?: number;
			outcome?: string;
			message?: { usage?: Record<string, number>; stopReason?: string };
			toolResults?: unknown[];
		};
		const dur = turnStartTs ? Date.now() - turnStartTs : undefined;
		const usage = e.message?.usage;
		if (usage) {
			tokens.input += usage.input ?? 0;
			tokens.output += usage.output ?? 0;
			tokens.cacheRead += usage.cacheRead ?? 0;
			tokens.cacheWrite += usage.cacheWrite ?? 0;
			tokens.total += usage.totalTokens ?? usage.total ?? 0;
		}
		write({
			t: "turn",
			phase: "end",
			turn: e.turnIndex ?? turnIndex,
			durMs: dur,
			outcome: e.outcome,
			stopReason: e.message?.stopReason,
			usage,
			tools: e.toolResults?.length ?? 0,
		});
		turnStartTs = 0;
		turns += 1;
		status(ctx, true);
	});

	pi.on("tool_call", async (event, ctx) => {
		const e = event as { toolCallId?: string; toolName?: string; input?: unknown; parentToolCallId?: string };
		const id = e.toolCallId || `${e.toolName}-${Date.now()}`;
		toolStarts.set(id, { name: e.toolName ?? "?", ts: Date.now() });
		currentTool = e.toolName;
		tools += 1;
		write({
			t: "tool",
			phase: "start",
			id,
			name: e.toolName,
			parent: e.parentToolCallId,
			args: slimArgs(e.toolName ?? "", e.input),
		});
		status(ctx, true);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const e = event as {
			toolCallId?: string;
			toolName?: string;
			durationMs?: number;
			isError?: boolean;
			result?: { details?: Record<string, unknown> };
		};
		const id = e.toolCallId ?? "";
		const start = toolStarts.get(id);
		const out = textOf(e.result);
		const ex = excerpt(out);
		const details = e.result?.details as Record<string, unknown> | undefined;
		const exitCode = (details?.exitCode ?? details?.exit_code) as number | undefined;
		const record: ToolRecord = {
			name: e.toolName ?? "?",
			task,
			item,
			ts: start?.ts ?? Date.now(),
			durMs: e.durationMs,
			wallMs: start ? Date.now() - start.ts : undefined,
			isError: !!e.isError,
			exitCode,
			outBytes: ex.bytes,
		};
		toolRecords.push(record);
		if (toolRecords.length > 2000) toolRecords = toolRecords.slice(-2000);
		write({
			t: "tool",
			phase: "end",
			id,
			name: e.toolName,
			parent: (e as { parentToolCallId?: string }).parentToolCallId,
			durMs: e.durationMs,
			wallMs: record.wallMs,
			isError: !!e.isError,
			exitCode,
			truncated: details?.truncated,
			outBytes: ex.bytes,
			...(CONTENT ? { out: ex.out } : {}),
		});
		toolStarts.delete(id);
		if (currentTool === e.toolName) currentTool = undefined;
		status(ctx, true);
	});

	pi.on("user_bash", async (event) => {
		const e = event as { command?: string };
		write({ t: "user_bash", chars: (e.command ?? "").length, ...(CONTENT ? { command: (e.command ?? "").slice(0, 4000) } : {}) });
	});

	pi.on("after_provider_response", async (event) => {
		const e = event as { status?: number; headers?: Record<string, string> };
		if (typeof e.status === "number" && e.status >= 400) {
			write({ t: "provider", status: e.status, requestId: e.headers?.["x-request-id"] });
		}
	});

	pi.on("session_compact", async (event) => {
		const e = event as { reason?: string; messagesBefore?: number; messagesAfter?: number };
		write({ t: "compact", reason: e.reason, before: e.messagesBefore, after: e.messagesAfter });
	});

	pi.on("session_compact_failed", async (event) => {
		const e = event as { reason?: string; error?: string };
		write({ t: "compact_failed", reason: e.reason, error: e.error });
	});

	pi.on("agent_settled", async (event) => {
		const e = event as { aborted?: boolean };
		const ms = taskStartTs ? Date.now() - taskStartTs : 0;
		if (taskStartTs) {
			lastTaskMs = ms;
			taskCount += 1;
		}
		taskStartTs = 0;
		taskList.push({ index: task, ms, turns, tools, tokens: { ...tokens }, aborted: !!e.aborted });
		if (taskList.length > 200) taskList = taskList.slice(-200);
		write({ t: "settle", taskMs: ms, aborted: !!e.aborted, turns, tools, tokens: { ...tokens } });
		writeDigest();
		status(uiCtx, false);
	});

	const summary = (): string => {
		const lines = [
			`log:    ${logPath ?? "(not created)"}`,
			`digest: ${digestPath ?? "(not created)"}`,
			`session ${sid} · cwd ${cwd}`,
			`tasks ${taskCount} · last ${fmtDur(lastTaskMs)} · current ${fmtDur(taskStartTs ? Date.now() - taskStartTs : 0)}`,
		];
		return lines.join("\n");
	};

	pi.registerCommand("workfeed", {
		description: "Show the workfeed paths and this session's counters",
		handler: async (_args, ctx) => {
			ctx.ui.notify(summary(), "info");
		},
	});
}
