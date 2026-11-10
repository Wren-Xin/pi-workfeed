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
 *   item  work item id currently in_progress (source-neutral; absent when none)
 *
 * Environment:
 *   PI_WORKFEED_DIR      log root (default ~/.pi/agent/logs)
 *   PI_WORKFEED_EXCERPT  tool-output excerpt bytes kept in the log (default 2048, 0 = keep none)
 *   PI_WORKFEED_CONTENT  set to 0 for metadata only: no prompt text, no tool output, no
 *                        command text, no todo text, paths reduced to their basename
 *   PI_WORKFEED_ARGS     tool arguments: full | redacted | shape | off
 *                        (default: shape when PI_WORKFEED_CONTENT=0, else redacted)
 *   PI_WORKFEED_OFF=1    disable this extension
 *
 * The collection policy is explicit because the log is meant to be shared: a
 * metadata-only log must stay safe to hand to a colleague or a bug report.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fmtDur, type TodoItem, type TokenBuckets } from "./digest.ts";
import { rebuildDigest, resumeState } from "./replay.ts";

const SCHEMA_VERSION = 1;
/** logs are sensitive: owner-only, best effort (Windows honours this partially) */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const EXCERPT = Math.max(0, Number(process.env.PI_WORKFEED_EXCERPT ?? 2048));
const CONTENT = process.env.PI_WORKFEED_CONTENT !== "0";
const ROOT = process.env.PI_WORKFEED_DIR || join(homedir(), ".pi", "agent", "logs");

/**
 * Argument policy — the one channel that used to leak regardless of CONTENT.
 *   full     every argument value, clipped only (debugging)
 *   redacted per-tool summary: command text, paths, pattern, sizes (default with content)
 *   shape    keys + string byte counts, no values at all (default in metadata-only)
 *   off      no `args` field
 */
type ArgsMode = "full" | "redacted" | "shape" | "off";
const ARGS_MODE: ArgsMode = (() => {
	const raw = (process.env.PI_WORKFEED_ARGS ?? "").toLowerCase();
	if (raw === "full" || raw === "redacted" || raw === "shape" || raw === "off") return raw;
	return CONTENT ? "redacted" : "shape";
})();

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

/**
 * Credentials inside free text are redacted even in content mode. This is
 * **best effort, not a guarantee**: patterns catch common shapes (flags, headers,
 * DSNs, cloud keys, JWTs, env assignments), they cannot catch a secret that looks
 * like an ordinary word. Treat the log as sensitive either way.
 */
function stripSecrets(text: string): string {
	return text
		// scheme://user:password@host — DSNs for postgres/mysql/redis/amqp…
		.replace(/\b([a-z][a-z0-9+.-]{1,15}:\/\/)[^\s:@/]+:[^\s@/]+@/gi, "$1<redacted>:<redacted>@")
		// --token value / API_KEY=value / DATABASE_URL=value …
		.replace(/(--?[a-z0-9_-]*(?:token|secret|passw(?:or)?d|api[-_]?key|auth|credential)[a-z0-9_-]*\s*[= ]\s*)("[^"]*"|'[^']*'|[^\s;|&]+)/gi, "$1<redacted>")
		.replace(/((?:[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|DATABASE_URL|DB_URL|DSN)[A-Za-z0-9_]*)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;|&]+)/gi, "$1<redacted>")
		// Authorization header, Bearer tokens
		.replace(/((?:authorization|bearer)\s*[:=]?\s*)([A-Za-z0-9._~+/=-]{8,})/gi, "$1<redacted>")
		.replace(/((?:api[_-]?key|secret|token|passw(?:or)?d)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;|&]+)/gi, "$1<redacted>")
		// curl -u user:password
		.replace(/((?:^|\s)-u\s+)[^\s:]+:[^\s]+/g, "$1<redacted>:<redacted>")
		// well-known token prefixes
		.replace(/\b(?:sk|ghp|gho|ghs|xox[baprs])[-_]?[A-Za-z0-9_-]{16,}/g, "<redacted-token>")
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-token>")
		// JWT: three base64url segments
		.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<redacted-token>")
		// inline PEM private keys
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted-private-key>");
}

/** Walk a value and redact every string inside it; used for tool arguments. */
function redactValue(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return stripSecrets(value);
	if (typeof value !== "object" || value === null) return value;
	if (depth > 6) return "<…>";
	if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v, depth + 1);
	return out;
}

/**
 * A path in metadata-only mode keeps its last segment only: "which file" survives,
 * "whose disk / which client folder" does not.
 */
function barePath(value: unknown): unknown {
	if (typeof value !== "string") return value;
	if (CONTENT) return value;
	const parts = value.split(/[\\/]+/).filter(Boolean);
	return parts.length ? `<…>/${parts[parts.length - 1]}` : value;
}

/** Structure without values: key names, plus string byte counts. */
function shapeArgs(input: unknown): unknown {
	const a = input as Record<string, unknown> | undefined;
	if (!a || typeof a !== "object") return undefined;
	const keys = Object.keys(a).sort();
	const stringBytes: Record<string, number> = {};
	for (const k of keys) {
		const v = a[k];
		if (typeof v === "string") stringBytes[k] = Buffer.byteLength(v, "utf8");
	}
	return { keys, ...(Object.keys(stringBytes).length ? { stringBytes } : {}) };
}

/** Shrink tool arguments: never put a whole file body into the log. */
function slimArgs(name: string, input: unknown): unknown {
	if (ARGS_MODE === "off") return undefined;
	if (ARGS_MODE === "shape") return shapeArgs(input);
	const a = input as Record<string, unknown> | undefined;
	if (!a) return undefined;
	// `full` and the per-tool fallback (unknown / MCP tools) serialize arbitrary
	// arguments, so redaction has to run on the value, not only on known fields.
	if (ARGS_MODE === "full") return safeJson(redactValue(a), 1200);
	const clip = (v: unknown, n = 2000) => (typeof v === "string" ? v.slice(0, n) : v);
	switch (name) {
		case "bash":
		case "powershell":
			return { command: stripSecrets(clip(a.command)), timeout: a.timeout };
		case "write":
			return {
				path: barePath(a.path),
				contentBytes: typeof a.content === "string" ? Buffer.byteLength(a.content) : undefined,
			};
		case "edit":
			return {
				path: barePath(a.path),
				oldBytes: typeof a.old_string === "string" ? Buffer.byteLength(a.old_string) : undefined,
				newBytes: typeof a.new_string === "string" ? Buffer.byteLength(a.new_string) : undefined,
				replaceAll: a.replace_all,
			};
		case "read":
		case "ls":
			return { path: barePath(a.path), offset: a.offset, limit: a.limit };
		case "grep":
			return { pattern: stripSecrets(clip(a.pattern)), path: barePath(a.path), glob: a.glob, output_mode: a.output_mode };
		default:
			// Unknown tools (MCP servers, custom extensions) have no shape we understand,
			// so this is the branch that used to leak: redact the values, then clip.
			return safeJson(redactValue(a), 1200);
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
	/** true only between a user prompt and its settle: gates ghost settle rows */
	let taskActive = false;
	let turns = 0;
	let tools = 0;
	let tokens = zeroTokens();

	let turnStartTs = 0;
	let turnIndex = 0;
	let toolStarts = new Map<string, { name: string; ts: number; task: number; item?: number }>();
	let currentTool: string | undefined;
	let lastTaskMs = 0;
	let taskCount = 0;

	let ticker: ReturnType<typeof setInterval> | undefined;
	let uiCtx: ExtensionContext | undefined;

	const restrict = (path: string, mode: number) => {
		try {
			chmodSync(path, mode);
		} catch {
			/* Windows honours this partially; never let permissions break logging */
		}
	};

	const write = (event: Record<string, unknown>) => {
		if (!logPath) return;
		events += 1;
		const line = JSON.stringify({ v: SCHEMA_VERSION, ts: Date.now(), sid, task, ...(item ? { item } : {}), ...event });
		try {
			appendFileSync(logPath, line + "\n", { encoding: "utf8", mode: FILE_MODE });
			restrict(logPath, FILE_MODE);
		} catch (err) {
			if (!warned) {
				warned = true;
				if (uiCtx?.hasUI) uiCtx.ui.notify(`workfeed: cannot write log: ${(err as Error).message}`, "error");
			}
		}
	};

	/** A session owns one log, wherever it was first written (date dirs are just filing). */
	const findExistingLog = (sessionId: string): string | undefined => {
		try {
			const days = readdirSync(ROOT, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name)
				.sort()
				.reverse();
			for (const day of days) {
				const candidate = join(ROOT, day, `workfeed-${sessionId}.jsonl`);
				if (existsSync(candidate)) return candidate;
			}
		} catch {
			/* root may not exist yet */
		}
		return undefined;
	};

	/**
	 * Point the writer at the right files. Re-binds when the session id changes
	 * (`/new`, `/resume` inside a live process) and reuses an existing log across
	 * days, so one session never splits into two date directories.
	 */
	const ensureFiles = (ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager.getSessionId?.() || "unknown";
		if (logPath && sessionId === sid) return;
		try {
			sid = sessionId;
			cwd = ctx.cwd;
			const existing = findExistingLog(sid);
			if (existing) {
				logPath = existing;
				digestPath = existing.replace(/\.jsonl$/, ".digest.md");
				return;
			}
			dir = join(ROOT, dayStamp());
			mkdirSync(dir, { recursive: true, mode: DIR_MODE });
			restrict(dir, DIR_MODE);
			logPath = join(dir, `workfeed-${sid}.jsonl`);
			digestPath = join(dir, `workfeed-${sid}.digest.md`);
			// a brand-new session starts its own numbering: `/new` must not inherit
			// the previous session's task counter
			task = 0;
			taskCount = 0;
			lastTaskMs = 0;
			item = undefined;
		} catch {
			logPath = undefined;
		}
	};

	/**
	 * Rewrite the digest — by replaying the JSONL, never from the counters above.
	 *
	 * The log is the truth and this process only witnesses part of it: a session
	 * reopened after a restart, a `/fork`, or 2 000 tool calls later, still renders
	 * from every line on disk. See `replay.ts` for the constraint.
	 */
	const writeDigest = () => {
		if (!digestPath || !logPath) return;
		try {
			if (!existsSync(logPath)) return;
			const md = rebuildDigest(logPath, { cwd: String(barePath(cwd)), model: uiCtx?.model?.id, provider: uiCtx?.model?.provider });
			writeFileSync(digestPath, md, { encoding: "utf8", mode: FILE_MODE });
			restrict(digestPath, FILE_MODE);
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
		const snapshotItems = toTodoItems(snapshot);
		item = snapshotItems.find((t) => t.status === "in_progress")?.id;
		const items = snapshotItems.map((t) => ({
			id: t.id,
			status: t.status,
			elapsedMs: t.elapsedMs,
			...(CONTENT ? { text: stripSecrets(t.text).slice(0, 120) } : { textChars: t.text.length }),
		}));
		const line = JSON.stringify(items);
		if (line === lastTodoLine) return;
		lastTodoLine = line;
		write({ t: "todo", rev: (snapshot as { rev?: number } | undefined)?.rev, items });
	});

	pi.on("session_start", async (event, ctx) => {
		ensureFiles(ctx);
		// A resumed session continues the log, so the task counter must continue too:
		// otherwise the second process writes a second `task: 1` and the join key lie
		// starts right there.
		if (logPath && existsSync(logPath)) {
			try {
				const resumed = resumeState(logPath);
				if (resumed.nextTask > task + 1) task = resumed.nextTask - 1;
				taskCount = Math.max(taskCount, resumed.tasks);
				if (resumed.lastTaskMs > 0) lastTaskMs = resumed.lastTaskMs;
			} catch {
				/* a broken tail must not stop the session from logging */
			}
		}
		startTicker(ctx);
		write({
			t: "session",
			reason: (event as { reason?: string })?.reason,
			cwd: barePath(cwd),
			sessionFile: barePath(ctx.sessionManager.getSessionFile?.()),
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
		taskActive = true;
		taskStartTs = Date.now();
		turns = 0;
		tools = 0;
		turnIndex = 0;
		tokens = zeroTokens();
		toolStarts = new Map();
		write({
			t: "prompt",
			chars: (e.prompt ?? "").length,
			...(CONTENT ? { text: stripSecrets(e.prompt ?? "").slice(0, 3000) } : {}),
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
			// self-hosted endpoints often send no total at all, some send 0:
			// `??` cannot rescue a literal 0, so fall back on the parts we do have.
			const reported = Math.max(usage.totalTokens ?? 0, usage.total ?? 0);
			tokens.total +=
				reported > 0
					? reported
					: (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
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
		// Ownership is frozen here: a long call must not be re-attributed if the
		// todo list moves to another item while it runs.
		toolStarts.set(id, { name: e.toolName ?? "?", ts: Date.now(), task, item });
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
		const outBytes = Buffer.byteLength(out, "utf8");
		const ex = excerpt(stripSecrets(out));
		const details = e.result?.details as Record<string, unknown> | undefined;
		const exitCode = (details?.exitCode ?? details?.exit_code) as number | undefined;
		const wallMs = start ? Date.now() - start.ts : undefined;
		write({
			t: "tool",
			phase: "end",
			id,
			name: e.toolName,
			parent: (e as { parentToolCallId?: string }).parentToolCallId,
			durMs: e.durationMs,
			wallMs,
			isError: !!e.isError,
			exitCode,
			truncated: details?.truncated,
			outBytes,
			...(CONTENT ? { out: ex.out } : {}),
			// Attribution stays where the call started, even if the todo list moved on.
			// `item: undefined` deliberately overrides the line's current item (JSON drops it).
			task: start ? start.task : task,
			item: start ? start.item : item,
		});
		toolStarts.delete(id);
		if (currentTool === e.toolName) currentTool = undefined;
		status(ctx, true);
	});

	pi.on("user_bash", async (event) => {
		const e = event as { command?: string };
		write({
			t: "user_bash",
			chars: (e.command ?? "").length,
			...(CONTENT ? { command: stripSecrets(e.command ?? "").slice(0, 4000) } : {}),
		});
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
		// `before_agent_start` returns early for non-user messages (compaction, injected
		// turns). Without this guard those settle with the *previous* task's counters
		// and a duration of 0 — a ghost row that reads like a real task.
		if (!taskActive) return;
		const ms = taskStartTs ? Date.now() - taskStartTs : 0;
		lastTaskMs = ms;
		taskCount += 1;
		taskStartTs = 0;
		taskActive = false;
		write({ t: "settle", taskMs: ms, aborted: !!e.aborted, turns, tools, tokens: { ...tokens } });
		// Counters belong to the task that just closed: reset so nothing leaks into it.
		turns = 0;
		tools = 0;
		turnIndex = 0;
		tokens = zeroTokens();
		toolStarts = new Map();
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

	// The digest is derived, so it can always be rebuilt from the log alone.
	pi.registerCommand("workfeed-digest", {
		description: "Rebuild the digest from the JSONL log (works after a restart)",
		handler: async (_args, ctx) => {
			writeDigest();
			ctx.ui.notify(`digest rebuilt from ${logPath ?? "(no log yet)"}`, "info");
		},
	});
}
