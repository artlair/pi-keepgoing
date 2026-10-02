/**
 * pi-keepgoing: auto-continue assistant turns that died mid-sentence.
 *
 * Some served models end a request whenever the sampled token matches any
 * id in the checkpoint's eos_token_id list, and GLM-style models list their
 * chat-template control tokens there: a turn normally ends with the literal
 * user-turn marker token, and a tool handoff ends with the observation
 * marker. The failure mode: the model tries to WRITE one of those strings
 * (quoting template code, docs or its own thinking) mid-answer, the sampler
 * emits the matching special-token id, vLLM reports a clean
 * finish_reason=stop, and the token itself is stripped from the output
 * (skip_special_tokens). pi sees a normal stop; the turn just dies
 * mid-sentence with no error. Agents that port or review chat-template code
 * hit this constantly, and every cut-off needs a manual "keep going".
 *
 * Mechanism: on agent_before_settle (pi's final actionable boundary), look
 * at the last assistant message. If the run completed, the stop reason is
 * "stop", there are no tool calls, the output stayed far below the model's
 * maxTokens, and the visible tail looks cut off (unclosed code fence,
 * dangling operator or bracket, or a long word-final line without closing
 * punctuation), append a custom_message telling the model to continue
 * exactly where it stopped and return continue: true for one more request.
 * Thinking-only stops (no text at all) are always treated as cut: the run
 * produced nothing user-visible.
 *
 * Loop guard: each continuation is visible in the transcript as a
 * keepgoing-continue custom message. Counting trailing assistant messages
 * back to the last real user message (skipping those markers) bounds the
 * chain at --max continuations per user prompt (default 3); past the cap the
 * extension gives up and notifies instead of looping forever. A /keepgoing
 * command toggles the whole thing per session.
 *
 * The heuristic is deliberately conservative: a false positive (a complete
 * reply that happens to end without punctuation) costs one cheap follow-up
 * where the model says it is done; a false negative just means the user
 * types "keep going" by hand, as before.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** One assistant content block we care about, structurally typed. */
interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
}

/** The pieces of an assistant message the heuristics need. */
interface AssistantLike {
	role: string;
	content: ContentBlock[];
	stopReason?: string;
	usage?: { output?: number };
	customType?: string;
}

/** How many auto-continues are allowed after one real user prompt. */
const DEFAULT_MAX_CONTINUATIONS = 3;
/** Never auto-continue an output this close to the model's maxTokens. */
const MAX_OUTPUT_FRACTION = 0.5;
/** Short one-liner replies that end word-final are still complete. */
const SHORT_REPLY_CHARS = 240;
/** How much of the cut tail to quote back at the model. */
const TAIL_SNIPPET_CHARS = 80;
/** customType stamped onto the continuation messages this extension appends. */
export const KEEPGOING_MARKER = "keepgoing-continue";

/** Characters that read as a finished ending (prose close, code fence, quote, table pipe). */
const COMPLETE_TAIL = new Set([".", "!", "?", ")", "]", "}", "'", '"', "|", "…"]); // backtick handled by the balanced-span rule
/** Characters that dangle when a generation is chopped: operators, opens, separators. */
const CUT_TAIL = new Set([",", ";", ":", "(", "{", "[", "=", "<", ">", "&", "@", "#", "$", "~", "^", "\\", "+", "-", "/", "%"]);

/**
 * Heuristic: does this text end mid-thought?
 * Conservative by design; see the module comment for the trade-off.
 */
export function looksTruncated(body: string): boolean {
	const trimmed = body.replace(/\s+$/, "");
	if (!trimmed) return true;
	// An odd number of fences means an unclosed code block.
	const fences = (trimmed.match(/```/g) ?? []).length;
	if (fences % 2 === 1) return true;
	const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim();
	// Horizontal rules and table separators are valid endings.
	if (/^[-=_*]{3,}$/.test(lastLine) || /^\|[-\s|:]+\|$/.test(lastLine)) return false;
	const last = trimmed[trimmed.length - 1];
	// A trailing backtick closes an inline span only when the final line's
	// backticks balance; an odd count means the last tick OPENS a span (the
	// classic "the marker is `" cut shape). The check is scoped to the last
	// line on purpose: quoting a cut-off tail earlier in the message embeds
	// a stray backtick mid-text, and a whole-message parity count misreads
	// that as an unclosed span even when the reply ended on a full stop.
	if (last === "`") return lastLine.replace(/```/g, "").replace(/[^`]/g, "").length % 2 === 1;
	if (COMPLETE_TAIL.has(last)) return false;
	if (CUT_TAIL.has(last)) return true;
	// Word-final: short one-liner replies are fine, anything longer is a cut.
	if (/[\p{L}\p{N}_]/u.test(last)) {
		const short = trimmed.length <= SHORT_REPLY_CHARS && trimmed.split("\n").length <= 2;
		return !short;
	}
	return false;
}

/**
 * Classify one assistant message: did the generation stop before the model
 * finished its turn? Thinking-only stops count as cut no matter how they
 * end, because the run produced nothing the user can read.
 */
export function classifyAssistantStop(message: AssistantLike): { truncated: boolean; tail: string } {
	const text = message.content
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("");
	if (text.trim().length > 0) {
		return { truncated: looksTruncated(text), tail: text.replace(/\s+$/, "").slice(-TAIL_SNIPPET_CHARS) };
	}
	const thinking = message.content
		.filter((b) => b.type === "thinking")
		.map((b) => b.thinking ?? "")
		.join("");
	const tail = thinking.replace(/\s+$/, "").slice(-TAIL_SNIPPET_CHARS);
	if (!thinking.trim()) {
		return { truncated: true, tail: tail || "(nothing; the reply was empty)" };
	}
	return { truncated: true, tail };
}

/**
 * Count continuations already spent in the current user-message span:
 * trailing assistant messages back to the last message that is neither an
 * assistant message nor one of this extension's continuation markers.
 * Returns [assistantCount, continuationCount].
 */
export function countTrailingRun(messages: AssistantLike[]): [number, number] {
	let assistants = 0;
	let continuations = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant") {
			assistants++;
			continue;
		}
		if (m.customType === KEEPGOING_MARKER) {
			continuations++;
			continue;
		}
		break;
	}
	return [assistants, continuations];
}

export default function (pi: ExtensionAPI) {
	let enabled = process.env.PI_KEEPGOING !== "0";

	pi.on("agent_before_settle", (event, ctx: ExtensionContext) => {
		if (!enabled) return undefined;
		if (event.outcome !== "completed") return undefined;
		// No canContinue check here: at settle the context ends with the
		// assistant message, so canContinue is false until our custom_message
		// is appended. pi re-validates the final context after handlers run.
		const messages = event.context.contextMessages as unknown as AssistantLike[];
		const last = messages[messages.length - 1];
		if (!last || last.role !== "assistant") return undefined;
		if (last.stopReason !== "stop") return undefined;
		if (last.content.some((b) => b.type === "toolCall")) return undefined;

		const maxTokens = ctx.model?.maxTokens ?? 0;
		const output = last.usage?.output ?? 0;
		if (maxTokens > 0 && output > maxTokens * MAX_OUTPUT_FRACTION) return undefined;

		const verdict = classifyAssistantStop(last);
		if (!verdict.truncated) return undefined;

		const [, continuations] = countTrailingRun(messages);
		if (continuations >= maxContinuations()) {
			notify(ctx, `pi-keepgoing: reply still cut off after ${continuations} continuations, giving up (tail: ${JSON.stringify(verdict.tail.slice(-40))})`);
			return undefined;
		}

		const prompt =
			`Your previous reply was cut off mid-stream (most likely an accidental end-of-sequence token, ` +
			`for example from quoting a chat-template control string). Continue exactly where you stopped; ` +
			`do not repeat or re-summarize anything. The reply ended with: ${JSON.stringify(verdict.tail)}`;
		const draft = {
			type: "custom_message" as const,
			customType: KEEPGOING_MARKER,
			content: prompt,
			display: true,
		};
		notify(ctx, `pi-keepgoing: reply cut off mid-sentence, auto-continuing (${continuations + 1}/${maxContinuations()})`);
		return { entries: [...event.entries, draft], continue: true };
	});

	function maxContinuations(): number {
		const parsed = Number.parseInt(process.env.PI_KEEPGOING_MAX ?? "", 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONTINUATIONS;
	}

	function notify(ctx: ExtensionContext, message: string): void {
		if (!ctx.hasUI) return;
		ctx.ui.notify(message, "warning");
	}

	pi.registerCommand("keepgoing", {
		description: "Toggle auto-continue of mid-sentence cut-off replies",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				enabled = arg === "on";
			} else if (arg === "" || arg === "status") {
				// bare: just report
			} else {
				ctx.ui.notify(`usage: /keepgoing [on|off|status] (currently ${enabled ? "on" : "off"})`, "warning");
				return;
			}
			ctx.ui.notify(`pi-keepgoing is ${enabled ? "on" : "off"} (max ${maxContinuations()} continuations per prompt)`, "info");
		},
	});
}
