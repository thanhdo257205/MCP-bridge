# agy-mcp-bridge

**An MCP server that hands bounded coding tasks to the CLI agents already logged in on your machine.** One TypeScript process speaks MCP Streamable HTTP on `127.0.0.1` and drives `agy` (Antigravity) and/or `codex`. Every task declares its workspace, acceptance criteria, which agent runs it, how isolated it is, and how much it may self-approve. The orchestrating agent (Codex, Claude Code, any MCP client) keeps the review; the bridge does the reading, writing and waiting.

> **There is no authentication, on purpose.** The bridge binds `127.0.0.1` only, but any process running as your user on this machine can call its tools, read and cancel tasks, and shut it down. Do not expose the port, do not put it behind a public reverse proxy, do not run it where you do not control local processes. [Security model](#security-model).

Package `agy-mcp-bridge` on npm · requires Node.js ≥ 20 · Git · a logged-in `agy` 1.4.x and/or Codex CLI.

## Install

```bash
npm install -g agy-mcp-bridge
agy-mcp-bridge workspaces add /path/to/your/project   # grant one folder (restart to apply)
agy-mcp-bridge                                       # serves http://127.0.0.1:3000, UI at /ui
```

Fastest first run: from inside the project you want to work on, `agy-mcp-bridge --workspace .` grants the current directory **for this run only** and does not touch config. Repeat the flag for several folders; a wrong path, or the bridge's own install directory, stops startup.

`agy-mcp-bridge check | setup codex|claude|both | delegation on|off|status | skill install | config | update | help`. `--open` launches the web UI in your browser. Config and task history live in the user data directory (`%APPDATA%\agy-mcp-bridge`, `~/.config/agy-mcp-bridge`, `~/Library/Application Support/agy-mcp-bridge`; override with `BRIDGE_HOME`), so an upgrade never deletes them. `agy-mcp-bridge config` prints the real paths.

At startup the bridge probes each CLI. An agent that is missing or unsupported is marked unavailable and takes no task; if `agy` is unavailable, the default agent silently becomes the next enabled one, so check `agents_list` after changing machines. Priority and per-agent switches live under `agents` in `config/workspaces.json`. Verified against real agent execution on `agy` 1.4.3, 1.4.7, 1.4.8 and 1.4.9; other 1.4.x patches run with a logged warning; other majors are refused.

From a git clone instead of npm: `npm ci && npm run build && npm start`, then `npm run check` in a second terminal. `npm run dev` builds and runs; there is no hot reload, because an automatic restart would cut off a task mid-edit.

## Connect a client

`agy-mcp-bridge setup codex` (or `claude`, `both`, with `--port` and `--shell`) prints the exact lines for your machine and changes nothing; `setup codex --apply` shows the diff, asks, and backs up `config.toml` first.

Codex — `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`):

```toml
[mcp_servers.antigravity]
url = 'http://127.0.0.1:3000/mcp'
startup_timeout_sec = 30
tool_timeout_sec = 115
```

Claude Code:

```bash
claude mcp add --transport http --scope local antigravity 'http://127.0.0.1:3000/mcp'
```

Then call `antigravity_environment` from a fresh session — that is the proof; `codex mcp list` and `/mcp` only show configuration. Closing or disconnecting a client does not stop the server or cancel an accepted task. Reconnect, read `recent_tasks`, and reuse the task id instead of delegating the same work twice.

## Delegate

```json
{
  "task": "Reject negative input in parseCount in src/count.ts. Change this function and its tests only. Do not run commands; the reviewer runs tests.",
  "workspace": "C:/absolute/path/to/approved-project",
  "acceptance_criteria": ["Negative input returns the existing validation error", "0 and positive values keep their behaviour"],
  "agent": "codex",
  "isolation": "worktree",
  "owns": ["src/count.ts", "test/count.test.ts"],
  "autonomy": "auto",
  "timeout_seconds": 300
}
```

| Field | Meaning |
|---|---|
| `agent` | id from `agents_list` (`antigravity`, `codex`), or a profile / pool id from [Agents, profiles and pools](#agents-profiles-and-pools). Omit for the highest-priority available agent; naming an unavailable agent errors rather than switching silently. |
| `isolation` | `none` (default — edits the workspace, globally serial) or `worktree` (branch `bridge/<task_id>` under `.bridge-state/worktrees/<task_id>`, parallel up to `max_parallel_worktrees`). Worktree tasks must declare `owns`, and the repo needs at least one commit. Uncommitted changes in the main checkout are **not** copied in. |
| `owns` | relative paths the agent may touch. After the run the bridge diffs the worktree against this list and reports anything else in `scope.out_of_scope`. It never auto-merges, never deletes the branch, and does not run repo hooks. |
| `autonomy` | `suggest` \| `auto` \| `full` — an instruction to the CLI agent, not a permission grant. Destructive actions stay hard-denied (see below). |

| Tool | What it does |
|---|---|
| `antigravity_environment` | CLI versions, allowlist, limits, agents, parallelism, `recent_tasks`, delegation switch |
| `agents_list` | probed agents, capabilities, availability, default agent, worktree limits (read-only) |
| `antigravity_delegate` | accepts a task, returns `running` (or `queued`) with a `task_id` |
| `antigravity_task_status` | cheap poll: state, pid, elapsed, errors, `denied_actions`, byte counts |
| `antigravity_task_wait` | blocks up to `wait_seconds` (default cap 55 s), returns early when the task ends |
| `antigravity_task_output` | final response, stdout/stderr, errors, `denied_actions`, truncation |
| `antigravity_cancel_task` | kills the task's process tree; does not revert file changes |
| `code_search` | XERJ passage/definition lookup; registered always but **refused while `xerj.enabled` is off** |

`completed` means the CLI exited with a parseable result — always `review_required: true`, `acceptance_verified: false`. A 0 exit code can still be reported as `failed` after a permission denial or a timeout. While a task runs, `wait`/`status` return a short `activity` line instead of making the client read logs.

Two switches control delegation itself: `agy-mcp-bridge delegation off` blocks new tasks immediately without a restart, and `BRIDGE_DELEGATION=off` pins it at startup. Tasks still refuse to be delegated by policy the skill describes (security, auth, secrets, data deletion, deploy, CI and public API changes are not delegated).

## Agents, profiles and pools

`agents.profiles.<id>` declares named agents that inherit an adapter and override its defaults (`env` such as `CODEX_HOME`, `model`, `executable`, `codex_sandbox`, `codex_ask_for_approval`). A profile id is a valid `agent` value and `agents_list` reports each one's availability and warnings.

Whether a profile really is a second account depends on the adapter. A `codex` profile with its own `CODEX_HOME` signs in separately, so two Codex accounts do run side by side. An `antigravity` profile does **not**: `agy` resolves its credential from the machine's own login (on Windows the credential is in the keyring, so pointing `HOME`, `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` at another directory changes nothing), which means several antigravity profiles share one Google account and a pool of them cannot fail over to spare quota. `agy` signs in through Google OAuth.

Four rules about these ids are easy to get wrong, all measured rather than inferred:

- `agents.enabled` must list **every profile id** you declare, not just the adapters. A profile missing there is silently disabled, and a pool of such members then refuses with `Pool "<pool id>" has no healthy member right now` — a message that names the pool while the broken line is `enabled`. Omitting `enabled` entirely enables everything; the example keeps the key so you can see it exists, which means a new profile has to be added to that list too.
- A `codex` profile also needs the base `codex` id in `enabled`, because that is what makes the bridge probe the codex CLI at all. Without it the profile is unavailable **and reports no warning**, so `agents_list` shows a dead agent with no reason.
- `model` on a profile is read only for a `codex` profile; an `antigravity` profile runs with the model you choose in the web UI.
- `priority` and `enabled` accept a pool id without complaining, but the default agent is matched against agent ids only — a pool there silently selects nothing. Name the pool in the `agent` argument of a task instead.

`agents.pools.<id>` groups profiles for quota handling. Delegating to a pool id picks the first healthy member. When a member stops with something that reads like an exhausted quota or rate limit, the bridge marks it cooling for `quota_cooldown_seconds` and re-runs **the same task** on the next member — each member at most once per task, after which the task fails instead of looping. The replaced attempt is kept on the record as `attempts[]` (agent, error, exit, log tails) so a reviewer can still see why the first CLI stopped, and the retry keeps holding the execution lock rather than releasing and re-taking it, so no second ordinary task slips into the gap.

The owner's Settings reach an `antigravity` **profile** exactly as they reach `antigravity`, because they key on the adapter behind the id, not on the id: the model, the permission level, the effort, and the soft deadline with its `--log-file` and its extended `--print-timeout` are all on the command line of a profile task. Read that as a widening, not a cosmetic fix — before, a profile was locked to the CLI's own defaults and could not be given `--dangerously-skip-permissions` at all; now your permission level applies to its tasks too, so a profile is no more restricted than the agent it comes from.

Two knobs are opt-in because they widen what the bridge can reach. Neither is reachable from a task, and neither stays invisible: the codex pair is reported in `agents_list` warnings, and the XERJ pair in `/api/xerj/status` plus the refusal `code_search` gives while it is off.

- `codex_sandbox: "danger-full-access"` / `codex_ask_for_approval: "never"` — readable from the bridge's own config file only. No task, tool argument or MCP client can ask for them, and `--ask-for-approval` is passed where codex accepts it (before `exec`).
- `xerj.enabled` / `xerj.auto_reference` — both default to `false`. Turning them on sends task text to another local service and can place a retrieved passage inside the prompt an agent follows, which is a decision for the machine's owner, not for a delegating client.

## Missions

A mission is a plan the bridge **records and gates but never runs**: up to 12 steps in one workspace, each carrying its own `delegate` arguments and a list of `depends_on`. An MCP client writes the plan and dispatches it one step at a time; the bridge refuses to start a step whose dependencies did not all complete, so no agent is sent at a step whose inputs do not exist yet. Nothing ever starts by itself — a restart restores every plan and re-dispatches nothing.

| Tool | What it does |
|---|---|
| `mission_create` | record the plan and return `mission_id`, progress and the `ready` step ids (the receipt does not echo the plan back) |
| `mission_extend` | append correction or follow-up steps: the plan is append-only, so a retry is always a new step |
| `mission_dispatch` | start one ready step as a normal supervised task; refused while a dependency is not `completed`, if the step already ran, or once the mission is canceled |
| `mission_status` | cheap poll: per-step state, `blocked_by`, `ready` — no task text |
| `mission_plan` | the whole recorded plan with each step's exact `delegate` arguments, for a client that lost its own copy |
| `mission_cancel` | close the plan so nothing further can be dispatched; running agents are left alone unless `cancel_running_tasks: true` |

A dispatched step **is** an ordinary task, so everything in [Delegate](#delegate) still applies to it: worktree isolation, `owns`, timeouts, redaction, process-tree release, `review_required`, and no auto-merge. Step state is derived from the task records on every read rather than cached, so a record that retention dropped shows as `lost` — which never unlocks the step waiting for it. Replies are deliberately small (`dispatch` returns five fields plus a `next_step` hint) because an orchestrator polls them; the **Nhiệm vụ** page is the human view. There is no `mission_list` — keep the `mission_id` you were given, or read it from that page.

The bundled `mission-orchestrator` skill teaches a client how to write such a plan (and when not to).

## Lifecycle and limits

Task state belongs to the HTTP server, not to the MCP session, and all clients share one TaskManager. `none`-lane tasks take a cross-process lock (`.bridge-state/execution.lock`); `worktree`-lane tasks rely on their own branch. Results persist to `.bridge-state/tasks/<task_id>.json` (0600, secret-redacted) and reload at startup, so you can recover an answer after a reconnect — this is history, not durable task recovery. Ctrl+C once: stop listening, cancel running tasks and reap their process trees, drain sockets for up to 3 s, print `[bridge] Stopped`. It does not revert files.

Defaults: 300 s per task (max 900 s; the owner may raise both to 3600 s in config), 256 KiB per output stream (1 KiB–1 MiB configurable, exceeding it cancels the task and reports `truncated`), 50 retained tasks (max 200), 2 parallel worktrees (1–8), 3 queued tasks (0–20). A timed-out task leaves its partial edits on disk — review them, then delegate a narrower task rather than resending the same one.

CLI agents spawn their own children (MCP servers, shells, tool helpers) rooted in the worktree; on Windows those outlive the agent and pin the directory, which is why the bridge records the process tree during the run and reaps the surviving branches after the agent exits, with `taskkill /T /F` after `git worktree remove` fails. PIDs are re-checked against a fresh process table before anything is signalled, so a recycled PID is skipped and reported in `cleanup.skipped`. The result appears as `cleanup` on the task record and in the UI. Watch cadence is `tree_watch` in config (`delays_ms`, or `enabled: false` to accept that an intermediate shell that exited early leaves its children invisible). A crash still has no guarantee: there is no Windows Job Object yet.

## Security model

- **Loopback only.** `127.0.0.1` is the only bind; there is no LAN option. `Host` must match the real address and port, foreign `Origin` is rejected, CORS stays off. `PORT` may change the port, or `PORT=0` to let the OS pick one — the URL printed at startup is then the truth for every client.
- **No auth.** Deliberate for a single-user dev machine: the protections that remain are loopback binding, Host/Origin checks, body limits, timeouts, a workspace allowlist, and an environment allowlist for child processes (names containing `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY` are stripped unless you explicitly add them to `extra_env_passthrough`).
- **Worktree isolation is a process boundary, not an OS sandbox.** The agent still runs as you. The allowlist validates realpath, boundary and traversal and rejects links/junctions in inputs, but `node_modules` and `.git` contents are not inspected, and OS/CLI-level permissions remain yours to control.
- **Hard-denied regardless of `autonomy`:** deploy/publish, data deletion, pushing to protected branches, reading credentials, system changes outside the workspace. The bridge never adds a bypass flag on its own initiative, and Codex tasks are never run with `--yolo` or a skipped approval prompt — an action that would need approval fails instead. The Antigravity permission level (`default` / `plan` / `accept-edits` / `auto` / `full`) is owner-only, set in the web UI; only `full` passes `--dangerously-skip-permissions` to `agy`, it takes approval away for commands and paths outside the workspace, and the two highest levels ask for confirmation and show a standing warning strip.
- Remote access from another machine would need TLS, real authentication/authorization and per-workspace isolation. Nothing here provides that.

Redaction recognises common secret shapes; it does not catch everything. Keep secrets out of tasks. Task records and prompts are stored so the UI can re-read them after a restart.

## Web UI

`http://127.0.0.1:3000/ui` on the same machine, no login (there is no auth to log into). It reads the same task store as the tools, so it costs your other agents no tokens. Pages: **Tasks** (bridge state, ready agents, delegation switch, per-task request/criteria/response, `denied_actions`, stdout/stderr, full prompt, worktree/branch and `owns` verdict, workspace changes with per-file line counts), **Nhiệm vụ** (every recorded plan: steps, states, which dependency blocks which step, the exact `delegate` arguments per step, and a **Dừng kế hoạch** button that closes the plan and never touches a running agent — the page reads and stops missions, it cannot dispatch one), and **Settings** (delegation, MCP endpoint, per-agent probe results, allowed workspaces, permission level, model, effort, wait cadence, soft deadline, step progress, usage, shutdown button). Regions patch in place, so selecting log text survives an update.

Long explanations, unverified notes and rarely-changed numbers live behind **More** blocks; decisions-worthy state stays visible. The no-auth warning is always visible, and the "allowlist is not a sandbox" warning is always visible at `auto`/`full`.

Model and effort apply to new tasks immediately, without a restart, and each task records what it was given. Only ids from `agy models` are offered. `probe-stream` shows what `agy --output-format stream-json` emits; step progress is opt-in and off by default. The **Usage** tab aggregates `usage` from every finished task to `.bridge-state/usage.jsonl`, per model and per effort; the token budget fields are an indicator light, not a cap — `agy` exposes no quota to the bridge.

**Workspace changes** are computed in a throwaway git directory with an empty config, borrowing only the object store: `git status`/`git diff` normally execute commands declared by the repository itself (`core.fsmonitor`, `filter.*.clean`, `diff.*.textconv`), and the agent can write files, so a poisoned `.git/config` is a real path. Disabling the external diff alone is not enough — there is a test that builds a poisoned repo and proves nothing runs.

## Development

```bash
npm test          # build + unit/integration with fake executables; no AI calls
npm run test:live # REAL agent calls, scratch workspace, disconnect/reconnect, cancel, shutdown
```

`npm test` runs serially (`--test-concurrency=1`, ~158 s): most cases start a real loopback server and time its output, so a parallel failure reflects machine load, not code. CI runs Windows and Linux on Node 20/22. Source map: `src/index.ts` entry, `src/http.ts` routing/shutdown, `src/runtime.ts` shared CLI + TaskManager, `src/agents` adapters and registry, `src/missions` the plan store and its dispatch gates, `src/isolation` worktrees and `owns`, `src/tasks` lifecycle/lock/output, `src/security` validation and redaction, `src/tools` tool definitions, `src/antigravity` child process, `ui/` plain HTML/CSS/JS with `src/ui/` behind it.

Pushing or merging to `main` runs CI and, when it passes, publishes to npm automatically: the [publish workflow](.github/workflows/publish.yml) bumps the patch version, tags, pushes and publishes through OIDC Trusted Publishing — no npm token in secrets, no manual version bump, nothing published if CI fails. PRs run [CI](.github/workflows/ci.yml) only. Set up once under the package's **Trusted Publisher** settings: user `thanhdo257205`, repository `MCP-bridge`, workflow `publish.yml`, empty environment, allow direct npm publish.

## Documentation

- [docs/HARDENING.md](docs/HARDENING.md) — hardening changes and the limits of what was verified.
- [docs/VERIFICATION.md](docs/VERIFICATION.md) — client CLI versions and live connection results.
- [docs/MULTI-AGENT-PLAN.md](docs/MULTI-AGENT-PLAN.md) — the multi-agent roadmap and per-phase status.
- [docs/HANDOFF.md](docs/HANDOFF.md) — open work (Job Object, POSIX E2E, worktree TTL) with mutation-test evidence.
- [docs/PROMPTS.md](docs/PROMPTS.md) — review and follow-up task prompts.
- [skills/antigravity-bridge/SKILL.md](skills/antigravity-bridge/SKILL.md), [skills/mission-orchestrator/SKILL.md](skills/mission-orchestrator/SKILL.md) and [docs/SKILL-EVAL.md](docs/SKILL-EVAL.md) — the client-side contract and manual evaluation cases.

Two skills ship with the bridge: `antigravity-bridge` teaches a client the real tool schemas, task-id recovery, timeouts, permission denials and diff review; `mission-orchestrator` teaches it how to write and drive a plan — when a mission is the right shape, how to keep it cheap, and what must never be put in one. First interactive run offers to install them (`agy-mcp-bridge skill install --client codex|claude|both [--skill <name>] [--update]` writes `~/.agents/skills/…` or `~/.claude/skills/…`); a `SKILL.md` you edited yourself is never overwritten, and one customized skill never blocks the other. Installing a skill does not connect the server or grant any permission.

MIT licensed; see `LICENSE`.
