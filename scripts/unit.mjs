#!/usr/bin/env node
// Unit tests for the pure helpers exported by pi-keepgoing.ts.
//
// jiti is resolved from pi's own install so the repo needs no dependencies.
// NOTE: never put chat-template control-token strings literally in here;
// construct them if a test ever needs one.
//
// Usage: node scripts/unit.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createJiti } from "/usr/lib/node_modules/pi/node_modules/jiti/lib/jiti.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const { looksTruncated, classifyAssistantStop, countTrailingRun, KEEPGOING_MARKER, VERSION } = await jiti.import(
	join(root, "pi-keepgoing.ts"),
);

let failures = 0;
function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

const fence = "`".repeat(3);
const longProse =
	"The template renders each message by prefixing it with its role token and a newline, then appends the " +
	"generation prompt when requested so the model knows it should start writing the assistant reply. Tool " +
	"results go through a separate observation role, and the system prompt always comes first in the sequence";

// looksTruncated
check("unclosed code fence is cut", looksTruncated(`Here is the template:\n\n${fence}python\ndef render(messages):\n    return out\n`), true);
check("closed code fence is not cut", looksTruncated(`Here:\n\n${fence}python\nx = 1\n${fence}\n`), false);
check("trailing ' is not cut", looksTruncated(`${longProse} and it is called 'render'`), false);
check("trailing . is not cut", looksTruncated(`${longProse}.`), false);
check("word-final long tail is cut", looksTruncated(longProse), true);
check("short one-liner word-final is not cut", looksTruncated("Sure, that works for me"), false);
check("dangling comma is cut", looksTruncated("The markers are user, assistant,"), true);
check("empty body is cut", looksTruncated("   \n"), true);
check("dangling opening backtick is cut", looksTruncated("The user-turn marker, written literally, is: `"), true);
check(
	"short word-final reply wins over unbalanced ticks",
	looksTruncated("use `x` then `y"),
	false,
);
check(
	"long word-final tail with dangling tick is cut",
	looksTruncated(longProse + ", then the span opens again: `y"),
	true,
);
check("balanced inline spans are not cut", looksTruncated("the `x` and `y` there."), false);
check(
	"odd quoted backticks mid-text do not cut a clean ending",
	looksTruncated("My reply ended at `...is: ` cleanly. All done, happy to dig in next."),
	false,
);
check("trailing closed inline span is not cut", looksTruncated("the marker reads `done`"), false);

// List-item endings: a reply that stops exactly on a self-contained list
// item is a finished list, not a mid-sentence chop. Regression for the
// real-world false positive: a numbered plan whose last line was
// "6. New publish.yml targeting the cluster registry with the
// <sha>-serve tag convention" (word-final, no closing punctuation).
const planList =
	"Here is the sequence:\n\n1. Provision the build VM on the hypervisor\n2. Join it to the cluster, labeled and tainted for builds\n" +
	"3. Add a runner scale set via the gitops repo\n4. Deploy the registry through the deploy loop with a local PV\n" +
	"5. Copy the repos off the old registry\n6. New publish workflow targeting the cluster registry";
check("numbered list ending word-final is not cut", looksTruncated(planList), false);
check(
	"bulleted list ending word-final is not cut",
	looksTruncated(`${longProse}. Next steps:\n\n- port the smoke test to the new lane\n- wire the cap into the config`),
	false,
);
check(
	"indented numbered sub-item ending word-final is not cut",
	looksTruncated(`${longProse}.\n  3. run the dry run against the target`),
	false,
);
check(
	"list item with balanced inline spans is not cut",
	looksTruncated("steps:\n\n1. edit `publish.yml` in the app repo"),
	false,
);
check(
	"list item with a dangling operator is still cut",
	looksTruncated("steps:\n\n1. set the registry to ("),
	true,
);
check(
	"list item with unbalanced inline backticks is still cut",
	looksTruncated("steps:\n\n6. New publish workflow targeting `the cluster registry"),
	true,
);

// classifyAssistantStop
const thinkingOnly = {
	role: "assistant",
	stopReason: "stop",
	content: [{ type: "thinking", thinking: "The template uses tokens like `" }],
};
check("thinking-only stop is truncated", classifyAssistantStop(thinkingOnly).truncated, true);
check("thinking-only tail quotes the thinking", classifyAssistantStop(thinkingOnly).tail, "The template uses tokens like `");
check("empty content is truncated", classifyAssistantStop({ role: "assistant", stopReason: "stop", content: [] }).truncated, true);
check(
	"complete text reply is not truncated",
	classifyAssistantStop({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: `${longProse}.` }] }).truncated,
	false,
);

// countTrailingRun: custom messages appear in contextMessages as role
// "custom" with customType preserved (see README).
check("VERSION is semver-ish", /^\d+\.\d+\.\d+$/.test(VERSION), true);
const user = { role: "user", content: [{ type: "text", text: "explain the template" }] };
const cutAssistant = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: longProse }] };
const marker = { role: "custom", customType: KEEPGOING_MARKER, content: "Continue exactly where you stopped" };
check("countTrailingRun over user, cut, marker, cut", countTrailingRun([user, cutAssistant, marker, cutAssistant]), [2, 1]);
check("countTrailingRun stops at a real user message", countTrailingRun([cutAssistant, marker, user, cutAssistant]), [1, 0]);
check(
	"countTrailingRun stops at a foreign custom message",
	countTrailingRun([user, { role: "custom", customType: "other-ext", content: "x" }, cutAssistant]),
	[1, 0],
);

if (failures > 0) {
	console.error(`\n${failures} test(s) failed`);
	process.exit(1);
}
console.log("\nall tests passed");
