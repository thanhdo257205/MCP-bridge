---
name: mission-orchestrator
description: Drive a dependency-ordered plan of delegated coding steps through the MCP bridge (mission_create / extend / dispatch / status / plan / cancel) - one step at a time, each step's agent and scope chosen up front, results reviewed before the next step unlocks. Use when work needs several delegated steps in an order, or to recover such a plan after a reconnect or restart.
---

# Mission Orchestrator

A mission is a plan the bridge **records and gates but never runs**: it stores the steps and refuses to start one whose dependencies have not completed. You decide the order, dispatch one step at a time, and wait. The bridge has no scheduler, no retry and no background thread; if you stop, the plan simply sits there until you or the user resumes it. Read `antigravity-bridge` first: delegation consent, the kill switch, task observation, permissions and review rules all apply unchanged to mission steps.

## When a mission is the right shape

Use one when the work is genuinely a sequence: implement → test what you changed → fix what the tests found, or several independent modules then an integration step. Use plain `antigravity_delegate` for a single bounded task; a plan of one step adds nothing. Never use a mission to make the bridge "run the whole feature by itself" - it will not, and every step still needs your dispatch call and your review.

## Before writing the plan

- Call `antigravity_environment` and `agents_list`. Require `bridge_status=ready`, `supported.missions=true`, `delegation.enabled=true` and `accepting_tasks=true`, and take the workspace from `allowed_workspaces` (an empty allowlist permits nothing). Read `limits`: `max_mission_steps`, `max_retained_missions`, `max_timeout_seconds`, `max_parallel_worktrees`.
- Every step runs in the mission's single `workspace`; a step that names another one is rejected. Plan one mission per repository.
- A step's `delegate.agent` may be a profile or pool id from `agents_list`, not only `antigravity` or `codex`. Bind a step to a **pool** only when it is acceptable for a different account to answer it; name one **profile** when the step depends on a specific login, model or environment. If a pooled step fails over, the retry runs in the **same** worktree, so the abandoned attempt's partial edits stay in the diff and count toward the next attempt's `scope` - read that step's `attempts` before trusting who wrote what.
- Look at the repository yourself first (status, the files in scope, existing untracked work) and record a baseline. The plan is where you write down what you already learned, so a step does not have to rediscover it.
- The tools do not list missions, so save the `mission_id` from the receipt the moment it returns. If it is lost, ask the user to read it in the web UI (Nhiệm vụ page) rather than recreating a plan that may already be running.

## Writing the plan

`mission_create` takes `{title, goal, workspace, steps[]}` and returns only a receipt (`mission_id`, `workspace`, `status`, `progress`, `ready`, `next_step`) - the plan is not echoed back. Each step is `{step_id, title, depends_on[], delegate}` where `delegate` is exactly the object you would pass to `antigravity_delegate` (`task`, `workspace`, `acceptance_criteria`, optional `context`, `timeout_seconds`, `agent`, `isolation`, `owns`, `autonomy`). Strict schema: unknown fields, a duplicate or self-referencing `step_id`, an unknown dependency, a cycle, a foreign workspace, a step timeout above the bridge ceiling, more than `limits.max_mission_steps` steps or a plan over the size limit are all refused at creation.

Write steps that can be checked without the next one:

```json
{
  "title": "Range validation for the parser",
  "goal": "Reject negative counts at the boundary and prove it with tests.",
  "workspace": "C:/absolute/path/to/approved-project",
  "steps": [
    {"step_id": "impl", "title": "Guard the parser", "depends_on": [],
     "delegate": {"task": "Reject negative values in parseCount (src/count.ts) and update its tests. Preserve the public API. Do not run commands; the Tech Lead runs tests.", "workspace": "C:/absolute/path/to/approved-project", "acceptance_criteria": ["Negative values return the existing validation error"], "context": "parseCount is called from 3 sites; all pass non-negative today.", "agent": "codex", "timeout_seconds": 300}},
    {"step_id": "verify", "title": "Run the checks", "depends_on": ["impl"],
     "delegate": {"task": "Add a regression test for the boundary found in step impl.", "workspace": "C:/absolute/path/to/approved-project", "acceptance_criteria": ["The new test fails before the fix and passes after"], "isolation": "worktree", "owns": ["test/count.test.ts"]}}
  ]
}
```

- `step_id` is a lowercase slug (`a-z0-9`, dot, dash, underscore, at most 64 characters). It is the only handle you get back, so name steps for what they prove (`impl`, `api-tests`, `fix-timeout-1`), not for their order.
- Give the dependent step the criteria you will need to check the step before it. `depends_on` should be the shortest honest chain: two ready steps can run in parallel when worktree-isolated, while a long chain serializes everything behind the first slow step.
- Put facts the agent cannot see into `context` (contracts, your findings, what is already done). Do not paste the repository, and do not write "as before" - a step is a fresh CLI conversation, and each one reads the files itself.
- Secrets do not belong in a plan: the bridge redacts secret-shaped text in titles, goals and step instructions before writing to disk, so a `[REDACTED]` in a recovered plan means the value is gone, not hidden.
- Size each step like a single delegation: one goal, a few files, measurable criteria, a `timeout_seconds` that fits. A mission of 12 small steps beats 2 giant ones - the gate gives you a review point between them.

## Driving it

The loop is always: dispatch one ready step → `antigravity_task_wait` on the `task_id` → read `mission_status` → review the diff → decide the next dispatch.

- Take the step id from `ready` in the receipt or in `mission_status`. A step outside `ready` is refused, and the error says which dependency is in what state; do not retry it hoping for a different answer.
- `mission_dispatch` starts the task with the arguments **recorded in the plan**, not with arguments you supply now. If the recorded instruction is wrong, append a corrected step with `mission_extend` - a step that already ran keeps its task and is never re-dispatched or edited.
- The dispatch reply for a `running` or `queued` step carries only `{mission_id, step_id, task_id, status, duration_ms, next_step}`. Save `mission_id`, `step_id` and `task_id` immediately, then wait. While a step runs, waiting is your whole job: no file reads, git, tests or messages between waits (see `antigravity-bridge`).
- Review the completed step **before** dispatching the one that depends on it. That is the point of the gate: the dependent step is built on top of what the previous step actually did, not on what it claimed.
- One dispatch per step at a time. A second concurrent call for the same step is refused ("already being dispatched"); two ready steps may both be started, but ordinary tasks run one at a time across the bridge, so the second waits in the queue (`status=queued`, no process, no file changes).
- `next_step` on every reply states what is actually possible now. Trust it over your memory of the plan.

## Reading state cheaply

`mission_status` is the call to make after a wait, a reconnect or a restart: one short entry per step (`state`, `task_id`, `blocked_by`, agent, `isolation`, `scope`) plus `progress` (`total`, `completed`, `active`, `ready`, `pending`, `unmet`), with no task text at all. `mission_plan` is the same view **with** the recorded delegate arguments - call it only when you have lost the plan (a new session, a compaction, a different client) rather than re-reading the repository to guess what you asked for.

States come from the task records, live: `ready` (dispatchable now), `pending` (a dependency is not `completed`), then the task's own status. `lost` means the bridge dropped that task record under retention - it is not a failure the agent reported, and it never unlocks the step waiting for it. If you need to know what that step changed, inspect the workspace and then append a new step; do not assume it completed.

## Corrections, failure and closing

| Situation | What to do |
|---|---|
| Dependency `failed`, `timeout`, `canceled` or `lost` | Nothing unlocks automatically. Read the step's task output, then `mission_extend` a new step (a new `step_id`) that carries the fix, with the failure output and what is already done in its `context`. |
| A pooled step ended `failed` with `attempts` | Every healthy member ran once and stopped. Read each attempt's error before deciding: quota-shaped text means the accounts are exhausted, which appending an identical step will not fix. Append the step again against one named profile, take that part yourself, or tell the user and stop. |
| A step needs a second attempt | Append a step; the plan is append-only, so an old `step_id` is permanently used. The same `task_id` is never started twice. |
| Work discovered while the plan runs | `mission_extend` while the mission is `open`. Keep the goal of the mission the same; add steps, do not rewrite history. |
| The plan no longer matches reality | `mission_cancel`. No further step can be dispatched and no further step can be appended. Start a new mission instead of forcing an old plan. |
| The user stops the work | `mission_cancel`. Running steps are **not** killed by it: the reply lists them in `running_tasks`, so tell the user they are still running and that stopping one is `antigravity_cancel_task` on that task - or your own decision, with `cancel_running_tasks=true`, which is a separate destructive choice, not a cleanup step. |

Partial file edits from a canceled or failed step stay on disk; nothing is rolled back, and a worktree branch is never merged by the bridge. `unmet` in `progress` counts exactly the steps that can no longer become ready on their own - when it is the only thing left, the plan needs a correction step or a cancel, not more waiting.

## Cost discipline

A mission multiplies delegations, so budget it like a project, not like a task. Choose the agent per step: a mechanical step (add tests, rename, format) goes to the cheap/fast default; a step whose cause is unknown or whose contract is delicate goes to a stronger agent, or you do it yourself. The bridge owner picks the model, not you. Estimate the mission's cost before the first dispatch from the number of steps and their `timeout_seconds`, tell the user what you expect, and stop to report when the real cost crosses that estimate rather than finishing the plan silently. Do not add "verify" steps that re-do work the previous step already proved; do not re-dispatch a step because a wait timed out client-side (the task is still running).

## Hard rules

`isError=true` is an error even when the client renders text. Never invent a mission tool, a field, or an HTTP payload; use the advertised names. Do not edit `.bridge-state` or the mission records on disk to change a plan, unlock a step, or forget a cancellation. Never plan or delegate deployment, a push to a protected branch, data deletion, credential access, dependency or CI changes, or system changes outside the workspace. Never merge a worktree branch yourself without the user's review of the diff. A mission is a plan of code edits under the same consent rules as one delegation: the user's approval to delegate is not approval to run the whole plan unattended.
