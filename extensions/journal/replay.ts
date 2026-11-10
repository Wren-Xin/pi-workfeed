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
 * No pi API is imported, so this doubles as the entry point of an offline analyzer.
 */

import { readFileSync } from "node:fs";
import {
	buildDigest,
	type DigestInput,
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
	/** todo id that was `in_progress` at that moment */
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

/**
 * Parse a log file into events. A torn final line (power loss mid-append) is
 * skipped instead of poisoning the replay, and nothing else is silently trimmed.
 */
export function parseLog(text: string): JournalEvent[] {
	const out: JournalEvent[] = [];
	for (const line of text.split("\n")) {
		const s = line.trim();
		if (!s) continue;
		try {
			const parsed = JSON.parse(s) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed as JournalEvent);
		} catch {
			/* skip the malformed line; keep every other fact */
		}
	}
	return out;
}

/**
 * Fold events into the digest input. Order matters only where the log itself is
 * ordered (last todo snapshot wins); totals are order-independent.
 */
export function aggregate(events: JournalEvent[], fallback: Partial<DigestInput> = {}): DigestInput {
	const first = events[0];
	const last = events[events.length - 1];

	const tasks: TaskStats[] = [];
	const tools: ToolRecord[] = [];
	let todos: TodoItem[] = [];
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
				todos = items.map((it, i) => ({
					id: typeof it.id === "number" ? it.id : i + 1,
					text: String(it.text ?? ""),
					status: String(it.status ?? "pending"),
					elapsedMs: typeof it.elapsedMs === "number" ? it.elapsedMs : 0,
				}));
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
		todos,
		quality: {
			started: startIds.size,
			calls: tools.length,
			unfinished: [...startIds].filter((id) => !endIds.has(id)).length,
			attributed: tools.filter((t) => t.item !== undefined).length,
			tasksWithTokens: tasks.filter((t) => t.tokens.total > 0).length,
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
	const events = parseLog(readFileSync(logPath, "utf8"));
	return buildDigest(aggregate(events, fallback));
}
