# pi-keepgoing

A [pi](https://pi.dev) coding agent extension that auto-continues assistant
turns that died mid-sentence: when a model stops early for no good reason,
pi-keepgoing appends a "continue exactly where you stopped" message and keeps
the turn going, so you stop typing "keep going" by hand.

## The problem

Some served models end a request whenever the sampled token matches any id
in the checkpoint's `eos_token_id` list. GLM-style models list their
chat-template control tokens there: a normal chat turn ends with the literal
user-turn marker token, a tool handoff ends with the observation marker.

The failure mode: the model tries to *write* one of those strings mid-answer
(quoting template code, tool-call docs, or its own thinking about them), the
sampler emits the matching special-token id, the server reports a clean
`finish_reason=stop`, and the token itself is stripped from the output
(`skip_special_tokens`). pi records a normal `stop`; the assistant turn just
dies mid-sentence, invisible token, no error anywhere. Agents porting or
reviewing chat-template code hit this constantly, and every cut-off needs a
manual "keep going".

Verified against GLM-5.3-Flash on vLLM (the fork served on our cluster).
The cut is sampled, not deterministic: when asked to write the user-turn
marker inline, the model usually spells it out as ordinary characters, but
in roughly 40% of runs it starts the marker inside its thinking (right after
an opening backtick), samples the special-token id, and the reply ends there
with no text at all. Putting the marker literally into the prompt does not
work as a trigger: it is tokenized as the special token and the model never
sees it.

## Mechanism

pi fires `agent_before_settle` as the final actionable boundary of a run. The
extension looks at the last assistant message and continues when all of this
holds:

- the run completed (not aborted, not errored);
- `stopReason` is exactly `"stop"`, and the message carries no tool calls;
- output stayed at or under half the model's `maxTokens` (near-cap stops are
  pi's overflow recovery business, not truncation);
- the visible tail looks cut off: unclosed code fence, dangling operator or
  open bracket, or a word-final line without closing punctuation. A
  thinking-only stop (no text at all) always counts as cut, because the run
  produced nothing the user can read. Short one-liner replies that end
  word-final ("Done") are left alone.

When it fires, the extension appends a `keepgoing-continue` custom message
("continue exactly where you stopped, do not repeat anything, here is the
tail you ended on") and returns `continue: true`, which buys one more model
request. The boundary re-fires after that request, so a chain of cuts keeps
getting resumed until the reply ends cleanly.

The handler deliberately does not check `event.context.canContinue`: at
settle the context ends with the assistant message, so pi reports
`canContinue: false` until the continuation message is appended. pi
re-validates the final context after all handlers have run.

Loop guard: continuations are counted per user-message span (the extension's
own marker messages are skipped when counting, everything else ends the
span). This relies on how pi projects the session into
`event.context.contextMessages`: a `custom_message` entry becomes a message
with `role: "custom"` and its `customType` preserved (`createCustomMessage`
in pi's `messages.js`, via `sessionEntryToContextMessages`); it only turns
into a `role: "user"` message later, in `convertToLlm` (`llmMessages`). So
`countTrailingRun` matches on `customType`, not on role or marker text. Past the cap (3 by default) it gives up and notifies instead of
looping. The heuristic is deliberately conservative: a false positive costs
one cheap follow-up where the model says it is done; a false negative is the
old status quo of typing "keep going" yourself.

## Usage

- `/keepgoing` shows the current state, `/keepgoing on|off` toggles it for
  the session (default on).
- `PI_KEEPGOING=0` disables it at load; `PI_KEEPGOING_MAX=5` raises the
  per-prompt continuation cap.
- Notifications tell you when a reply was resumed and when the cap was hit.

## Install

Copy or symlink `pi-keepgoing.ts` into your pi extensions directory (pi
auto-discovers `~/.pi/agent/extensions/*.ts`; `/reload` picks changes up):

```sh
cp pi-keepgoing.ts ~/.pi/agent/extensions/
```

No dependencies, no build step: pi loads TypeScript extensions directly.

## Tests

- `node scripts/unit.mjs`: unit tests for the exported heuristics
  (`looksTruncated`, `classifyAssistantStop`, `countTrailingRun`), loading
  the TypeScript through the jiti bundled with pi.
- `scripts/smoke.sh`: end to end against the live GLM lane using the default
  provider from `~/.pi/agent/settings.json`. Because the cut is sampled, each
  phase retries (up to `ATTEMPTS=5`) until the model actually cuts; a cut
  without a continuation fails immediately.

Never write chat-template control-token strings literally in this repo,
tests or prompts; construct them (printf, concatenation) or spell them out.
