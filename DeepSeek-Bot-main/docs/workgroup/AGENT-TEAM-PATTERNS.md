# Agent-team patterns worth borrowing

Status: research note. It compares external designs with this repository's copied group-chat round,
and separates what can be adopted without leaving that architecture from what cannot.

## 1. What this repository already has

The workgroup is a copy of the original group chat: a shared ordered log, one speaker at a time,
`openingSpeakers` for the opening slot set, and `callMembers` for the continuation after a speaker's
`@Name`. The Bot's role and instructions are already in its own identity prompt. The workgroup adds
a Hub roster, remote Bot endpoints, sequence-numbered events and an outbox.

Therefore the useful comparison is not "which agent framework has a nicer graph". It is:

- who chooses the next speaker;
- how a handoff is represented;
- what survives a crash/restart;
- how duplicate delivery and cancellation are handled;
- how a person stays the owner of another person's Bot.

## 2. OpenClaw

### 2.1 What is actually stable

The merged multi-agent design is documented in
[multi-agent routing](https://github.com/openclaw/openclaw/blob/main/docs/concepts/multi-agent.md)
and [parallel specialist lanes](https://github.com/openclaw/openclaw/blob/main/docs/concepts/parallel-specialist-lanes.md).

Its shape is:

- each agent has an isolated workspace, agent directory and session store;
- bindings route a channel/account to an agent;
- a coordinator is the human's point of contact and delegates bounded work to specialists;
- specialists return artifacts/results and do not recursively delegate;
- lane contracts in `AGENTS.md` state owns/non-goals/handoff/tool posture;
- concurrency is treated as a scarce resource, with per-session serialization and caps.

The `feat(teams): add multi-agent teams implementation` PR
([#27382](https://github.com/openclaw/openclaw/pull/27382)) is **closed and not merged**. It proposes
`TeamCreate`/`SendMessage`/`TeamDelete` tools. It is useful as a design sketch, not as a dependency
or a standard to copy.

### 2.2 The most relevant idea: persistent completion ownership

The merged
[subagent yield handoff](https://github.com/openclaw/openclaw/blob/main/docs/concepts/subagent-yield-handoff.md)
document is closer to this repository's hardest problem than its team PR. Its invariants are:

- a registry, not the ended turn, owns child completion;
- the handoff persists yield intent and a frozen child batch;
- one completion owner at a time;
- a later turn is admitted with fresh execution authority, not revived old authority;
- exactly one continuation is owed for a settled batch;
- duplicate terminal callbacks cannot finalize twice;
- restart restores pending completion reservations without resending consumed results;
- cancellation/stop retires owed inputs and reports a stopped child once.

This is directly applicable to a workgroup remote slot. Our current `remoteWaiters` is process-local;
a coordinator restart loses it. The right improvement is not a new orchestrator but a persisted
round/slot obligation with one owner, one exchange id, one continuation, and restart reconciliation.

### 2.3 What not to take

- Do not copy the unmerged team tools or their tool names.
- Do not turn every Bot into a separately bound Gateway agent; this repo already has Bot identities,
  group Sessions and a Hub roster.
- Do not add a second role router. The coordinator role is the group admin, and the "lane contract" is
  already the Bot's `role`/`instructions`.

## 3. WeClaw

[WeClaw](https://github.com/zxinyun/weclaw) is a WeChat AI Agent Bridge. Its own README describes:

- ACP long-running subprocesses over JSON-RPC/stdio, CLI subprocesses, or HTTP chat completions;
- slash commands such as `/codex` and `/claude` to select an agent;
- media upload/download and proactive messaging;
- config for a default agent and per-agent aliases.

It is a **transport/bridge**, not an agent-team scheduler. It has no group speaker selection,
round/continuation ledger, multi-agent handoff protocol, or cross-device ownership model to borrow.
Its only relevant lesson is architectural: keep the transport adapter separate from the agent
runtime and persist the selected route (`default_agent` survives restart). That is already the
shape of this repository's `hub`/`bridge`/`workgroup` split.

## 4. AutoGen

[SelectorGroupChat](https://github.com/microsoft/autogen/blob/main/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_selector_group_chat.py)
is the closest working analogue of our round:

- a manager owns a message thread and selects the next speaker;
- `selector_func` can override model selection and is validated against participant names;
- `candidate_func` filters candidates;
- `allow_repeated_speaker`, `max_turns` and `max_selector_attempts` bound the loop;
- `save_state`/`load_state` persist the message thread, current turn and previous speaker;
- a handoff is a message type and the next speaker is chosen from the thread.

What is worth borrowing:

1. a **pure selection boundary**: input = thread + candidates + per-agent descriptions, output = one
   speaker; this is exactly our `openingSpeakers`/`callMembers` boundary;
2. **candidate filtering before selection**, which can become an explicit capability/mention filter
   without changing the round;
3. **persisted current turn and previous speaker**, which is the missing durability we identified.

What not to borrow:

- model-based selector as a replacement for the admin's explicit `@Name`; the original group is
  deliberately deterministic and does not spend a model call to choose a speaker;
- a new framework, event bus or participant runtime.

## 5. LangGraph supervisor and OpenAI Agents handoffs

LangGraph's supervisor docs now recommend the **supervisor pattern through tools** and note that
persistence needs a checkpointer/store. Its `create_handoff_tool` passes full history by default and
allows custom handoff tools and message insertion. OpenAI Agents models a handoff as a tool
(`transfer_to_<agent>`), supports `input_filter`, `on_handoff`, `is_enabled`, and explicitly notes
that handoffs stay within one run.

These validate three design choices already present here:

- a handoff is a tool/control event, not a free-form broadcast;
- the recipient gets a filtered slice of history, not the whole world;
- durable continuation requires state storage, not just an in-memory callback.

They do not solve this repo's distributed problem: a run/checkpointer is single-process state, while
our handoff crosses two machines and a Hub. Copying their graph API would duplicate the round.

## 6. Recommendation for this repository

Keep the original round. Add only the durability and identity pieces the external designs expose:

1. **Persist the round obligation, not just the waiter.**
   Store `{ roundId, roomId, slotIndex, exchangeId, memberId, endpointId, state }` under the workgroup
   domain's state file (or a small side table), with states `waiting`, `answered`, `stale`, `cancelled`.
   On restart, reconcile `waiting` entries from the Hub log:
   - a matching answer exists -> append it once and continue the round;
   - no answer and the round is stale -> mark `missed`/`stale`, never wait 240 s;
   - cancelled -> retire it, do not post a late answer.

2. **One completion owner and one continuation.**
   The round's coordinator owns the slot. A Hub replay or a second device's copy must not resolve it
   twice. Use `exchangeId` as the idempotency key, as OpenClaw's registry does with its batch ids.

3. **Persist `configVersion` for settings.**
   The Hub already has `config_version`; return it on the group/roster and reject an older local
   snapshot. This turns the current "last writer by arrival order" into "last accepted version".

4. **Do not borrow WeClaw's model.**
   It is a bridge. If the product later needs WeChat, it should be another channel adapter feeding
   this same Hub/protocol, not a second agent-team implementation.

5. **Do not borrow the unmerged OpenClaw team PR.**
   Its coordinator/team-tool idea is compatible with this design, but its API is not stable and its
   process-tree assumptions do not match a multi-user Hub.

## 7. Suggested order if this is pursued

1. Persist round/slot obligations and add restart reconciliation (the largest real gap).
2. Add `configVersion` compare-and-apply for settings.
3. Make the Hub authoritative for Bot endpoint name/owner in the event, and reject a forged
   `botEndpointId`.
4. Split workgroup feed refresh by `kind` to avoid reading the roster on every message.
5. Only then consider WeChat/WeClaw-style channel adapters.

None of these requires leaving the copied original group architecture.
