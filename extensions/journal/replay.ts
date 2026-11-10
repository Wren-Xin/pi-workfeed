/**
 * Replay layer — the architecture constraint in code.
 *
 * JSONL is the single truth. Everything the digest shows is recomputed from that
 * file, never carried over from the process that happened to be collecting:
 *
 *   JSONL → parseLog() → aggregate() → buildDigest()
 *
 * Consequences that this module is responsible for keeping true:
 *   - a digest can be deleted at any time and regenerated, including long after the
 *     session that produced it has exited;
 *   - a fresh process that reopens an existing session file renders the whole
 *     session, not just the part it witnessed;
 *   - no retention cap belongs here: caps are a UI concern, never a truth concern;
 *   - the same file yields byte-identical output (the timestamp is the last event's
 *     ts), so digests can be compared, checksummed and diffed.
 *
 * No pi API is imported, so this doubles as the offline replay entry point (there is no CLI:
 * see README "No CLI, on purpose").
 */

import { readFileSync } from "node:fs";
import {
	buildDigest,
	type DigestInput,
	type LogIntegrity,
	type TaskStats,
	type TodoItem,
	type TokenBuckets,
	type ToolRecord,
} from "./digest.ts";

/** One log line. Fields beyond the four join keys belong to the event type. */
export interface JournalEvent {
	v?: number;
	ts?: number;
	sid?: string;
	/** 1-based user-instruction index */
	task?: number;
	/** work item id (source-neutral: todo list, planner or external list) that was `in_progress` */
	item?: number;
	/** event type: session | prompt | turn | tool | todo | settle | … */
	t?: string;
	[k: string]: unknown;
}

const zeroTokens = (): TokenBuckets => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function dayStamp(ts?: number): string {
	const d = ts ? new Date(ts) : new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function tokensOf(raw: unknown): TokenBuckets {
	const u = raw as Record<string, number> | undefined;
	if (!u) return zeroTokens();
	const input = u.input ?? 0;
	const output = u.output ?? 0;
	const cacheRead = u.cacheRead ?? 0;
	const cacheWrite = u.cacheWrite ?? 0;
	const sum = input + output + cacheRead + cacheWrite;
	// A missing total arrives as 0 from self-hosted endpoints, so `??` never fires:
	// take the reported value only when it is actually positive.
	const reported = Math.max(u.totalTokens ?? 0, u.total ?? 0);
	return { input, output, cacheRead, cacheWrite, total: reported > 0 ? reported : sum };
}

/** What a replay could not use, and why — see `digest.ts` for the field meanings. */
export type { LogIntegrity };

export interface ParsedLog {
	events: JournalEvent[];
	integrity: LogIntegrity;
}

const EVENT_TYPES = new Set([
	"session",
	"prompt",
	"agent_start",
	"turn",
	"tool",
	"todo",
	"user_bash",
	"provider",
	"compact",
	"compact_failed",
	"settle",
	"shutdown",
]);

/** Envelope check from the protocol, kept here so a consumer can reuse it. */
function envelopeError(e: Record<string, unknown>): string | null {
	if (e.v !== 1) return `v=${String(e.v)} (this reader understands v=1)`;
	if (!Number.isInteger(e.ts) || (e.ts as number) < 0) return "ts is not a non-negative integer";
	if (typeof e.sid !== "string" || e.sid.length === 0) return "sid is not a non-empty string";
	if (!Number.isInteger(e.task) || (e.task as number) < 0) return "task is not a non-negative integer";
	if (typeof e.t !== "string" || e.t.length === 0) return "t is not a non-empty string";
	if (e.item !== undefined && (!Number.isInteger(e.item) || (e.item as number) < 1)) return "item is present but not an integer ≥ 1";
	return null;
}

/**
 * Parse a log file into events plus an account of what was dropped.
 *
 * A torn final line is expected (a process killed mid-append) and is reported as
 * `tornTail`. Anything unreadable *before* the tail is corruption and is listed
 * line by line. Envelope failures and unknown event types are kept separate:
 * the first means the producer broke the protocol, the second is normal forward
 * compatibility.
 */
export function parseLogDetailed(text: string): ParsedLog {
	const raw = text.split("\n");
	const integrity: LogIntegrity = { lines: 0, tornTail: null, corrupt: [], badEnvelope: [], unknown: [] };
	const events: JournalEvent[] = [];

	let lastNonEmpty = -1;
	for (let i = raw.length - 1; i >= 0; i -= 1) {
		if (raw[i].trim() !== "") {
			lastNonEmpty = i;
			break;
		}
	}

	for (let i = 0; i < raw.length; i += 1) {
		const s = raw[i].trim();
		if (!s) continue;
		integrity.lines += 1;
		let parsed: unknown;
		try {
			parsed = JSON.parse(s);
		} catch {
			if (i === lastNonEmpty) integrity.tornTail = i + 1;
			else integrity.corrupt.push(i + 1);
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			integrity.badEnvelope.push({ line: i + 1, reason: "not a JSON object" });
			continue;
		}
		const obj = parsed as Record<string, unknown>;
		const reason = envelopeError(obj);
		if (reason) {
			integrity.badEnvelope.push({ line: i + 1, reason });
			continue;
		}
		if (!EVENT_TYPES.has(String(obj.t))) integrity.unknown.push({ line: i + 1, t: String(obj.t) });
		events.push(obj as JournalEvent);
	}

	return { events, integrity };
}

/** Events only — the shape every existing caller wants. */
export function parseLog(text: string): JournalEvent[] {
	return parseLogDetailed(text).events;
}

/** Does the file need to be reported as damaged? Torn tail is expected, not damage. */
export function hasDamage(integrity: LogIntegrity): boolean {
	return integrity.corrupt.length > 0 || integrity.badEnvelope.length > 0;
}

/** One-line human summary, used by the CLI and by callers that log. */
export function describeIntegrity(integrity: LogIntegrity): string {
	const parts = [`${integrity.lines} lines`];
	if (integrity.tornTail !== null) parts.push(`torn tail at line ${integrity.tornTail}`);
	if (integrity.corrupt.length > 0) parts.push(`${integrity.corrupt.length} corrupt in the middle (lines ${integrity.corrupt.join(", ")})`);
	if (integrity.badEnvelope.length > 0) parts.push(`${integrity.badEnvelope.length} violating the envelope`);
	if (integrity.unknown.length > 0) parts.push(`${integrity.unknown.length} of unknown type (${[...new Set(integrity.unknown.map((u) => u.t))].join(", ")})`);
	return parts.join(" · ");
}

/**
 * Fold events into the digest input. Order matters only where the log itself is
 * ordered (last todo snapshot wins); totals are order-independent.
 */
export function aggregate(
	events: JournalEvent[],
	fallback: Partial<DigestInput> = {},
	integrity?: LogIntegrity,
): DigestInput {
	const first = events[0];
	const last = events[events.length - 1];

	const tasks: TaskStats[] = [];
	const tools: ToolRecord[] = [];
	// Item ids are unique for the whole session (protocol I2), so every snapshot can be
	// *merged* instead of replacing the previous one. Taking only the last snapshot made a
	// `clear` erase the timing of items that tool calls still reference.
	const itemsById = new Map<number, TodoItem>();
	let prompts = 0;
	let model = fallback.model;
	let provider = fallback.provider;
	let cwd = fallback.cwd ?? "";
	const startIds = new Set<string>();
	const endIds = new Set<string>();

	for (const e of events) {
		switch (e.t) {
			case "session":
				if (typeof e.model === "string") model = e.model;
				if (typeof e.provider === "string") provider = e.provider;
				if (typeof e.cwd === "string") cwd = e.cwd;
				break;
			case "prompt":
				prompts += 1;
				// a prompt after /model switch reflects the model actually used
				if (typeof e.model === "string") model = e.model;
				break;
			case "tool": {
				if (e.phase === "start") {
					startIds.add(String(e.id ?? ""));
					break;
				}
				if (e.phase !== "end") break;
				endIds.add(String(e.id ?? ""));
				tools.push({
					name: String(e.name ?? "?"),
					task: e.task ?? 0,
					item: e.item,
					ts: e.ts ?? 0,
					durMs: typeof e.durMs === "number" ? e.durMs : undefined,
					wallMs: typeof e.wallMs === "number" ? e.wallMs : undefined,
					isError: !!e.isError,
					exitCode: typeof e.exitCode === "number" ? e.exitCode : undefined,
					outBytes: typeof e.outBytes === "number" ? e.outBytes : undefined,
				});
				break;
			}
			case "todo": {
				const items = e.items as Array<Record<string, unknown>> | undefined;
				if (!Array.isArray(items)) break;
				const seen = new Set<number>();
				items.forEach((it, i) => {
					const id = typeof it.id === "number" ? it.id : i + 1;
					seen.add(id);
					const prev = itemsById.get(id);
					itemsById.set(id, {
						id,
						text: typeof it.text === "string" ? it.text : prev?.text ?? "",
						status: typeof it.status === "string" ? it.status : prev?.status ?? "pending",
						elapsedMs: typeof it.elapsedMs === "number" ? it.elapsedMs : prev?.elapsedMs ?? 0,
						dropped: false,
					});
				});
				// An item that vanished from the list was cleared away; its timing is a fact
				// that already happened, so it is marked rather than deleted (protocol I8).
				for (const [id, it] of itemsById) if (!seen.has(id)) it.dropped = true;
				break;
			}
			case "settle":
				tasks.push({
					index: e.task ?? tasks.length + 1,
					ms: typeof e.taskMs === "number" ? e.taskMs : 0,
					turns: typeof e.turns === "number" ? e.turns : 0,
					tools: typeof e.tools === "number" ? e.tools : 0,
					tokens: tokensOf(e.tokens),
					aborted: !!e.aborted,
				});
				break;
		}
	}

	return {
		sid: first?.sid ?? fallback.sid ?? "unknown",
		date: dayStamp(first?.ts),
		// deterministic: same file => same digest bytes
		generatedAt: last?.ts ?? Date.now(),
		model,
		provider,
		cwd,
		events: events.length,
		tasks,
		tools,
		todos: [...itemsById.values()],
		quality: {
			started: startIds.size,
			calls: tools.length,
			unfinished: [...startIds].filter((id) => !endIds.has(id)).length,
			attributed: tools.filter((t) => t.item !== undefined).length,
			tasksWithTokens: tasks.filter((t) => t.tokens.total > 0).length,
			// A prompt with no settle is a task that never closed (killed, crashed, still
			// running). It is not zero-duration — it is unknown, and must be said out loud.
			prompts,
			unsettled: Math.max(0, prompts - tasks.length),
			integrity,
		},
	};
}

/** What a fresh process needs from an existing log before it appends: the task counter. */
export interface ResumeState {
	/** next task index this process must use */
	nextTask: number;
	tasks: number;
	lastTaskMs: number;
}

export function resumeState(logPath: string): ResumeState {
	const events = parseLog(readFileSync(logPath, "utf8"));
	let maxTask = 0;
	let tasks = 0;
	let lastTaskMs = 0;
	for (const e of events) {
		if (typeof e.task === "number" && e.task > maxTask) maxTask = e.task;
		if (e.t === "settle") {
			tasks += 1;
			lastTaskMs = typeof e.taskMs === "number" ? e.taskMs : lastTaskMs;
		}
	}
	return { nextTask: maxTask + 1, tasks, lastTaskMs };
}

/** Rebuild the digest text from a JSONL path. Throws only if the file is unreadable. */
export function rebuildDigest(logPath: string, fallback: Partial<DigestInput> = {}): string {
	return replayLog(logPath, fallback).text;
}

/**
 * Replay a file and hand back both the rendered digest and the integrity report,
 * so a caller (the CLI, a test) can warn about damage instead of printing a
 * digest that looks complete.
 */
export function replayLog(logPath: string, fallback: Partial<DigestInput> = {}): { text: string; integrity: LogIntegrity } {
	const { events, integrity } = parseLogDetailed(readFileSync(logPath, "utf8"));
	return { text: buildDigest(aggregate(events, fallback, integrity)), integrity };
}
