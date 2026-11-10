/**
 * Digest builder — a pure function, no pi API, no I/O.
 *
 * The digest is derived data: it holds aggregate facts only, never advice.
 * It is rebuilt from `workfeed-<sid>.jsonl`; deleting every digest file must be
 * harmless, because that log is the truth.
 */

export interface TokenBuckets {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface TaskStats {
	/** 1-based user-instruction index, same value as the `task` field in events */
	index: number;
	/** wall clock from prompt to agent_settled, ms */
	ms: number;
	turns: number;
	tools: number;
	tokens: TokenBuckets;
	aborted: boolean;
}

export interface ToolRecord {
	name: string;
	task: number;
	item?: number;
	ts: number;
	/** monotonic duration reported by pi, ms (may be absent for blocked calls) */
	durMs?: number;
	/** wall clock from tool_call to tool_execution_end, ms */
	wallMs?: number;
	isError: boolean;
	exitCode?: number;
	outBytes?: number;
}

export interface TodoItem {
	id: number;
	text: string;
	status: string;
	elapsedMs: number;
	/** true when a later snapshot dropped the item (e.g. `clear`): kept, never zeroed */
	dropped?: boolean;
}

/**
 * What a replay could not use, and why. Skipping a bad line is acceptable;
 * skipping it silently is not — the digest has to state how much of the file it
 * could read, or a clean-looking digest hides a hole in the middle of history.
 */
export interface LogIntegrity {
	/** non-empty lines seen */
	lines: number;
	/** 1-based line number of an unparsable *final* line (a killed append), else null */
	tornTail: number | null;
	/** 1-based line numbers that failed to parse in the middle of the file */
	corrupt: number[];
	/** lines that parsed but violate the envelope (wrong `v`, missing/typed-wrong key) */
	badEnvelope: Array<{ line: number; reason: string }>;
	/** event types this version does not know: tolerated, but reported */
	unknown: Array<{ line: number; t: string }>;
}

export interface DigestInput {
	sid: string;
	date: string;
	generatedAt: number;
	model?: string;
	provider?: string;
	cwd: string;
	events: number;
	tasks: TaskStats[];
	tools: ToolRecord[];
	todos: TodoItem[];
	/** how much of the raw stream the tables above actually cover */
	quality?: {
		/** calls that emitted a start line */
		started: number;
		/** calls that emitted both start and end */
		calls: number;
		/** start lines with no matching end line: crash, kill or abort */
		unfinished: number;
		/** finished calls carrying an `item` attribution */
		attributed: number;
		/** settled tasks whose token total is non-zero */
		tasksWithTokens: number;
		/** user prompts seen (one per task) */
		prompts?: number;
		/** prompts with no settle: killed, crashed, or still running */
		unsettled?: number;
		/** what the parser had to drop, and why */
		integrity?: LogIntegrity;
	};
}

const pct = (part: number, whole: number): string =>
	whole > 0 ? `${Math.round((part / whole) * 100)}%` : "-";

export const fmtDur = (ms: number | undefined): string => {
	if (!ms || ms < 0) return "0s";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
};

const clip = (text: string, n: number): string => (text.length <= n ? text : text.slice(0, n - 1) + "…");

const fmtTokens = (t: TokenBuckets): string => {
	if (!t || t.total === 0) return "0";
	const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
	return `${k(t.input + t.cacheRead + t.cacheWrite)} in / ${k(t.output)} out / ${k(t.total)} total`;
};

/** Slowest tool calls, in duration order (monotonic duration wins over wall clock). */
export function slowestTools(tools: ToolRecord[], n = 5): ToolRecord[] {
	return tools
		.filter((t) => t.durMs !== undefined)
		.slice()
		.sort((a, b) => (b.durMs ?? 0) - (a.durMs ?? 0))
		.slice(0, n);
}

/** Tool calls grouped by name, ordered by total time spent. */
export function toolRollup(tools: ToolRecord[], n = 8): Array<{ name: string; count: number; total: number; max: number; failed: number }> {
	const map = new Map<string, { name: string; count: number; total: number; max: number; failed: number }>();
	for (const t of tools) {
		const e = map.get(t.name) ?? { name: t.name, count: 0, total: 0, max: 0, failed: 0 };
		e.count += 1;
		e.total += t.durMs ?? 0;
		e.max = Math.max(e.max, t.durMs ?? 0);
		e.failed += t.isError ? 1 : 0;
		map.set(t.name, e);
	}
	return [...map.values()].sort((a, b) => b.total - a.total).slice(0, n);
}

export function buildDigest(input: DigestInput): string {
	const { tasks, tools, todos } = input;
	const lines: string[] = [];

	lines.push("# workfeed digest");
	lines.push("");
	lines.push(`> derived from workfeed-${input.sid}.jsonl at ${new Date(input.generatedAt).toISOString()} — regenerate, do not hand-edit.`);
	lines.push("");
	lines.push(`- session: ${input.sid}`);
	lines.push(`- date: ${input.date}`);
	lines.push(`- model: ${input.model ?? "?"}${input.provider ? ` (${input.provider})` : ""}`);
	lines.push(`- cwd: ${input.cwd}`);
	lines.push(`- events: ${input.events}`);
	lines.push("");

	// ---- data quality: what the tables below cannot tell you ----
	if (input.quality) {
		const q = input.quality;
		const pctAttr = q.calls > 0 ? `${Math.round((q.attributed / q.calls) * 100)}%` : "-";
		lines.push("## data quality");
		lines.push("");
		lines.push(`- tool calls: ${q.calls} finished${q.unfinished > 0 ? `, ${q.unfinished} started without an end line (crash, kill or abort)` : ""}`);
		lines.push(`- item attribution: ${q.attributed}/${q.calls} calls carry an item (${pctAttr})`);
		lines.push(`- token totals: ${q.tasksWithTokens}/${tasks.length} tasks report a non-zero total`);
		if (q.prompts !== undefined) {
			const open = q.unsettled ?? 0;
			lines.push(
				`- task coverage: ${tasks.length}/${q.prompts} prompts have a settle${open > 0 ? ` — ${open} ${open === 1 ? "was" : "were"} killed or ${open === 1 ? "is" : "are"} still open, so ${open === 1 ? "its" : "their"} duration and tokens are unknown, not zero` : ""}`,
			);
		}
		const integ = q.integrity;
		if (integ) {
			const dropped = integ.corrupt.length + integ.badEnvelope.length;
			lines.push(
				`- log integrity: ${integ.lines} lines, ${dropped} dropped${dropped > 0 ? ` (${integ.corrupt.length} unparsable, ${integ.badEnvelope.length} violating the envelope)` : ""}, ${integ.unknown.length} of unknown type`,
			);
			if (integ.tornTail !== null) {
				lines.push(`- torn tail: line ${integ.tornTail} was an interrupted append; everything before it was used`);
			}
			if (integ.corrupt.length > 0) {
				lines.push(`- corrupt lines: ${integ.corrupt.join(", ")} — facts around them survive, but any ordering near them is lost`);
			}
			for (const bad of integ.badEnvelope.slice(0, 3)) {
				lines.push(`- rejected line ${bad.line}: ${bad.reason}`);
			}
			if (integ.badEnvelope.length > 3) {
				lines.push(`- rejected lines: ${integ.badEnvelope.length} total, first 3 shown`);
			}
			if (integ.unknown.length > 0) {
				lines.push(`- unknown event types: ${[...new Set(integ.unknown.map((u) => u.t))].join(", ")} (ignored; the format is forward compatible)`);
			}
		}
		lines.push("");
	}

	// ---- tasks ----
	const totalMs = tasks.reduce((a, t) => a + t.ms, 0);
	lines.push(`## tasks (${tasks.length}, wall clock ${fmtDur(totalMs)})`);
	lines.push("");
	if (tasks.length === 0) {
		lines.push("_none yet_");
	} else {
		lines.push("| # | time | turns | tools | tokens | status |");
		lines.push("|---|---|---|---|---|---|");
		for (const t of tasks) {
			lines.push(
				`| ${t.index} | ${fmtDur(t.ms)} | ${t.turns} | ${t.tools} | ${fmtTokens(t.tokens)} | ${t.aborted ? "aborted" : "ok"} |`,
			);
		}
	}
	lines.push("");

	// ---- tools ----
	const done = tools.filter((t) => t.durMs !== undefined || t.isError);
	const fails = done.filter((t) => t.isError).length;
	lines.push(`## tools (${tools.length} ${tools.length === 1 ? "call" : "calls"}, ${fails} failed)`);
	lines.push("");
	const rollup = toolRollup(tools);
	if (rollup.length === 0) {
		lines.push("_none yet_");
	} else {
		lines.push("| tool | calls | total | avg | max | failed |");
		lines.push("|---|---|---|---|---|---|");
		for (const r of rollup) {
			const avg = r.count > 0 ? r.total / r.count : 0;
			lines.push(`| ${r.name} | ${r.count} | ${fmtDur(r.total)} | ${fmtDur(avg)} | ${fmtDur(r.max)} | ${r.failed} |`);
		}
	}
	lines.push("");

	const slow = slowestTools(tools, 5);
	if (slow.length > 0) {
		lines.push("slowest calls");
		lines.push("");
		for (const t of slow) {
			lines.push(`- ${fmtDur(t.durMs)} · ${t.name} · task ${t.task}${t.item ? ` · item ${t.item}` : ""}${t.isError ? " · FAILED" : ""}`);
		}
		lines.push("");
	}

	const failed = tools.filter((t) => t.isError).slice(-5);
	if (failed.length > 0) {
		lines.push("last failures");
		lines.push("");
		for (const t of failed) {
			lines.push(`- ${t.name} · task ${t.task}${t.exitCode !== undefined ? ` · exit ${t.exitCode}` : ""} · ${new Date(t.ts).toISOString().slice(11, 19)}`);
		}
		lines.push("");
	}

	// ---- todo ----
	lines.push(`## todo items (${todos.length})`);
	lines.push("");
	if (todos.length === 0) {
		lines.push("_none_");
	} else {
		const doneCount = todos.filter((t) => t.status === "completed").length;
		const droppedCount = todos.filter((t) => t.dropped).length;
		const elapsedTotal = todos.reduce((a, t) => a + t.elapsedMs, 0);
		lines.push(
			`${doneCount}/${todos.length} completed · accumulated in-progress time ${fmtDur(elapsedTotal)}${droppedCount > 0 ? ` · ${droppedCount} dropped from the list (timing kept)` : ""}`,
		);
		lines.push("");
		lines.push("| id | status | elapsed | share | text |");
		lines.push("|---|---|---|---|---|");
		for (const t of todos) {
			const status = t.dropped ? `${t.status} · dropped` : t.status;
			lines.push(`| ${t.id} | ${status} | ${fmtDur(t.elapsedMs)} | ${pct(t.elapsedMs, elapsedTotal)} | ${clip(t.text.replace(/\|/g, "\\|"), 60)} |`);
		}
	}
	lines.push("");

	return lines.join("\n");
}
