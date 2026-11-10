/**
 * pi-workfeed · todo — a todo tool with per-item timing.
 *
 * The list is model-facing state; it is persisted in two places on purpose:
 *   - tool result `details`   → correct after /fork and /tree (branch replay)
 *   - `pi.appendEntry` custom  → survives compaction, which drops old messages
 *
 * Every *state change* is published on the extension event bus as
 * `workfeed:todo`, so the journal extension can attribute turns, tool calls and
 * tokens to the item that was in progress at that moment. UI ticks (the 2s status
 * line repaint) never publish: an unchanged list emits nothing.
 *
 * Environment:
 *   PI_WORKFEED_TODO_OFF=1  disable this extension
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TodoStatus = "pending" | "in_progress" | "completed";

interface Todo {
	id: number;
	text: string;
	status: TodoStatus;
	/** start of the current in_progress stretch (ms), cleared when it ends */
	startedAt?: number;
	/** accumulated in_progress time (ms) */
	elapsedMs: number;
}

interface TodoDetails {
	action: "write" | "list" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

const CUSTOM_TYPE = "workfeed:todo";

const Params = Type.Object({
	action: StringEnum(["write", "list", "clear"] as const),
	todos: Type.Optional(
		Type.Array(
			Type.Object({
				text: Type.String({ description: "One-line task description, verb first" }),
				status: Type.Optional(StringEnum(["pending", "in_progress", "completed"] as const)),
			}),
			{ description: "Complete list for action=write; missing status means pending" },
		),
	),
});

function fmtDur(ms: number | undefined): string {
	if (!ms || ms < 0) return "0s";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** Elapsed for one item: accumulated + the stretch still running. */
function itemElapsedMs(t: Todo, now = Date.now()): number {
	const base = t.elapsedMs || 0;
	return t.status === "in_progress" && t.startedAt ? base + (now - t.startedAt) : base;
}

/** Ids are join keys, so recovery falls back to max+1, never to length+1. */
function maxIdOf(todos: Todo[]): number {
	return todos.reduce((m, t) => Math.max(m, t.id), 0);
}

function summarize(todos: Todo[], now = Date.now()): string {
	if (todos.length === 0) return "todo list is empty";
	const done = todos.filter((t) => t.status === "completed").length;
	const active = todos.find((t) => t.status === "in_progress");
	const total = todos.reduce((acc, t) => acc + itemElapsedMs(t, now), 0);
	const head = `${done}/${todos.length} done · ${fmtDur(total)} accumulated`;
	return active ? `${head} · in progress: ${active.text} (${fmtDur(itemElapsedMs(active, now))})` : head;
}

function listText(todos: Todo[], now = Date.now()): string {
	if (todos.length === 0) return "todo list is empty";
	const icon = (s: TodoStatus) => (s === "completed" ? "x" : s === "in_progress" ? ">" : "o");
	const lines = todos.map((t) => {
		const el = itemElapsedMs(t, now);
		return `${icon(t.status)} #${t.id} ${t.text}${el ? ` (${fmtDur(el)})` : ""}`;
	});
	lines.push(summarize(todos, now));
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_WORKFEED_TODO_OFF === "1") return;

	let todos: Todo[] = [];
	let nextId = 1;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let lastCtx: ExtensionContext | undefined;
	/** signature of the state last published; equality means "nothing changed" */
	let lastSig = "";
	/** monotonic snapshot counter; consumers can drop duplicates by it */
	let rev = 0;

	/** What consumers care about: ids, texts, statuses and closed timing stretches. */
	const sigOf = () =>
		JSON.stringify({ n: nextId, t: todos.map((t) => [t.id, t.text, t.status, t.startedAt ?? 0, t.elapsedMs]) });

	/** An empty list is the resting state, not a change: startup stays silent. */
	lastSig = sigOf();

	/**
	 * Publish state so the journal can attribute events to an item.
	 * Emits only when the state actually changed — the consumer's view is exactly
	 * what was last emitted, so an identical snapshot would only add a duplicate
	 * line. Branch replay goes through the same rule.
	 */
	const publish = (ctx: ExtensionContext) => {
		const sig = sigOf();
		if (sig === lastSig) return;
		lastSig = sig;
		rev += 1;
		pi.events.emit("workfeed:todo", { todos: todos.map((t) => ({ ...t })), nextId, rev, sessionId: ctx.sessionManager.getSessionId?.() });
	};

	const persist = () => {
		pi.appendEntry(CUSTOM_TYPE, { todos: todos.map((t) => ({ ...t })), nextId });
	};

	/**
	 * Rebuild from the active branch. Custom entries outrank tool details once
	 * they exist, because compaction drops messages but keeps custom entries.
	 */
	const reconstruct = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;
		const branch = ctx.sessionManager.getBranch();
		for (const entry of branch) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				const d = entry.data as { todos?: Todo[]; nextId?: number } | undefined;
				if (d?.todos) {
					todos = d.todos.map((t) => ({ ...t, elapsedMs: t.elapsedMs || 0 }));
					nextId = d.nextId ?? maxIdOf(todos) + 1;
				}
				continue;
			}
			if (entry.type !== "message") continue;
			const msg = entry.message as { role?: string; toolName?: string; details?: unknown };
			if (msg.role !== "toolResult" || (msg.toolName !== "workfeed_todo" && msg.toolName !== "todo")) continue;
			const d = msg.details as TodoDetails | undefined;
			if (d?.todos) {
				todos = d.todos.map((t) => ({ ...t, elapsedMs: t.elapsedMs || 0 }));
				nextId = d.nextId ?? maxIdOf(todos) + 1;
			}
		}
		renderStatus(ctx);
		publish(ctx);
	};

	/** UI only: repaint the status line. Runs every 2s, so it must never emit events. */
	const renderStatus = (ctx: ExtensionContext | undefined) => {
		if (!ctx) return;
		if (ctx.hasUI) {
			if (todos.length === 0) {
				ctx.ui.setStatus("workfeed-todo", "");
			} else {
				const done = todos.filter((t) => t.status === "completed").length;
				const active = todos.find((t) => t.status === "in_progress");
				const parts = [`${done}/${todos.length}`];
				if (active) parts.push(`> ${active.text.slice(0, 28)} ${fmtDur(itemElapsedMs(active))}`);
				ctx.ui.setStatus("workfeed-todo", parts.join(" · "));
			}
		}
	};

	const startTicker = (ctx: ExtensionContext) => {
		lastCtx = ctx;
		if (ticker || !ctx.hasUI) return;
		ticker = setInterval(() => renderStatus(lastCtx), 2000);
	};

	const stopTicker = () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		reconstruct(ctx);
		startTicker(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstruct(ctx);
	});
	pi.on("session_shutdown", async () => {
		stopTicker();
	});

	pi.registerTool({
		name: "workfeed_todo",
		label: "Todo",
		description:
			"Maintain the task list and time each item automatically. action=write replaces the whole list (timing is kept for items whose text matches); action=list is read-only; action=clear empties it. Item ids keep counting up for the whole session and are never reused, so they stay unique join keys. Keep at most one item in_progress.",
		promptSnippet: "Track multi-step work in a task list with per-item timing",
		promptGuidelines: [
			"Use workfeed_todo with action=write for work that needs 3+ steps, and update statuses as you go; keep exactly one item in_progress.",
			"Call workfeed_todo again after each meaningful step so progress is visible, and mark an item completed only once its result is verified.",
		],
		parameters: Params,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action;
			const now = Date.now();

			if (action === "list") {
				renderStatus(ctx as ExtensionContext);
				return {
					content: [{ type: "text", text: listText(todos, now) }],
					details: { action, todos: [...todos], nextId } as TodoDetails,
				};
			}

			if (action === "clear") {
				const count = todos.length;
				todos = [];
				// `nextId` deliberately survives a clear: item ids are join keys, so they
				// must never be reused inside one session (a second list's #1 would
				// collide with the first list's #1 in the journal).
				persist();
				renderStatus(ctx as ExtensionContext);
				publish(ctx as ExtensionContext);
				return {
					content: [{ type: "text", text: `cleared ${count} item(s)` }],
					details: { action, todos: [], nextId } as TodoDetails,
				};
			}

			const incoming = params.todos ?? [];
			if (incoming.length === 0) {
				return {
					content: [{ type: "text", text: "error: write needs a non-empty todos array (use clear to empty the list)" }],
					details: { action, todos: [...todos], nextId, error: "empty todos" } as TodoDetails,
				};
			}

			const prevByText = new Map(todos.map((t) => [t.text, t]));
			const next: Todo[] = [];
			for (const raw of incoming) {
				const text = raw.text.trim();
				if (!text) continue;
				const status: TodoStatus = raw.status ?? "pending";
				const prev = prevByText.get(text);
				const item: Todo = prev ? { ...prev } : { id: nextId++, text, status, elapsedMs: 0 };

				// leaving in_progress: close the running stretch
				if (item.status === "in_progress" && item.startedAt && status !== "in_progress") {
					item.elapsedMs = (item.elapsedMs || 0) + Math.max(0, now - item.startedAt);
					item.startedAt = undefined;
				}
				// entering in_progress: open a stretch
				if (status === "in_progress" && !item.startedAt) item.startedAt = now;
				// rolling back to pending keeps the timing: history is for review
				item.status = status;
				next.push(item);
			}

			const actives = next.filter((t) => t.status === "in_progress");
			todos = next;
			persist();
				renderStatus(ctx as ExtensionContext);
				publish(ctx as ExtensionContext);

			const warn = actives.length > 1 ? `\n(note: ${actives.length} items are in_progress; keep one)` : "";
			return {
				content: [{ type: "text", text: `${listText(todos, now)}${warn}` }],
				details: { action, todos: [...todos], nextId } as TodoDetails,
			};
		},

		renderCall(args, theme) {
			let s = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.todos?.length) s += theme.fg("dim", ` (${args.todos.length} items)`);
			return new Text(s, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as TodoDetails | undefined;
			if (d?.error) return new Text(theme.fg("error", `error: ${d.error}`), 0, 0);
			if (!d?.todos) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			const now = Date.now();
			const done = d.todos.filter((t) => t.status === "completed").length;
			const active = d.todos.find((t) => t.status === "in_progress");
			const head =
				theme.fg("success", `${done}/${d.todos.length}`) +
				(active ? " " + theme.fg("accent", `> ${active.text}`) : "") +
				" " +
				theme.fg("dim", `${fmtDur(d.todos.reduce((a, t) => a + itemElapsedMs(t, now), 0))} accumulated`);
			const show = expanded ? d.todos : d.todos.slice(-3);
			const lines = show.map((t) => {
				const glyph = t.status === "completed" ? theme.fg("success", "x") : t.status === "in_progress" ? theme.fg("accent", ">") : theme.fg("dim", "o");
				const el = itemElapsedMs(t, now) ? theme.fg("dim", ` ${fmtDur(itemElapsedMs(t, now))}`) : "";
				const txt = t.status === "completed" ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
				return `${glyph} ${theme.fg("accent", `#${t.id}`)} ${txt}${el}`;
			});
			return new Text([head, ...lines].join("\n"), 0, 0);
		},
	});

	pi.registerCommand("wf-todos", {
		description: "Show the task list with per-item timing",
		handler: async (_args, ctx) => {
			// branch navigation can leave memory stale; replay before showing
			reconstruct(ctx);
			ctx.ui.notify(listText(todos), "info");
		},
	});
}
