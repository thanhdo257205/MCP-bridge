# Orca feature map

[Orca](https://github.com/stablyai/orca) (fork: `thanhdo257205/orca`) is an Electron desktop "AI orchestrator": it runs many CLI agents side by side, each in its own worktree, with a chat/terminal UI, diffs, a browser, a mobile companion and a CLI that agents use to drive it. This bridge is a different kind of program — one loopback MCP server with no auth that a single orchestrating client calls — so a feature only transfers when it survives that shape. This page lists every feature Orca's README names and what happened to it here.

## Taken into the bridge

| Orca feature | In the bridge | Where |
|---|---|---|
| **Supported agents** (Claude Code, Codex, Antigravity, OpenCode, … "any CLI agent") | A **Claude Code** adapter, the agent Orca lists first and the bridge did not have. Opt-in, `claude -p --output-format json`, session resume, quota failover, narrow approval-queue grants. | `src/agents/claude.ts`, README "Claude Code" |
| **Review AI Output** — notes on exact changed lines, sent back to the agent | `task_feedback` (MCP) and click-a-line notes in the web UI diff: notes become one follow-up task that quotes the lines, starts from the reviewed changes and continues the conversation. | `src/review/feedback.ts`, README "Review notes" |
| **`orca.yaml` setup script** per worktree | `worktree_setup` in the **owner's** config (argv lists, no shell), run in each new worktree before the agent, inside the task's own process. Never read from the repository. | `src/isolation/setup.ts`, README "Worktree setup" |
| **Mobile App** — "get pinged when an agent needs you" | `notify`: one POST per finished task to a URL the owner chooses (an ntfy topic reaches a phone), with `denied` and `quota` named apart from plain failures. No remote control: the bridge still accepts nothing from off the machine. | `src/notify.ts`, README "Notifications" |
| **Usage & Accounts** — switch accounts without logging out | Claude Code profiles with their own `CLAUDE_CONFIG_DIR`, in a pool that fails over on a rate/usage limit. Codex already had this with `CODEX_HOME`. | `config/workspaces.example.json` (`claude-work`) |

## Already in the bridge before

| Orca feature | Bridge equivalent |
|---|---|
| Parallel Worktrees | `isolation: "worktree"` + `owns`, up to `max_parallel_worktrees`, branch `bridge/<task_id>`, scope check, apply/discard from the UI. |
| Orchestrate Agents (coordinator → workers, task DAGs) | Missions: a recorded plan of up to 12 steps with `depends_on`, dispatched one gated step at a time. |
| Usage tracking | The Usage tab (`usage.jsonl`), per model and effort; Claude Code runs now add `total_cost_usd`. |
| Orca CLI | `agy-mcp-bridge` CLI plus the MCP tools themselves. |

## Not taken, and why

| Orca feature | Why it does not fit |
|---|---|
| Worker `ask` / coordinator `reply` while a worker runs | Every CLI the bridge drives runs headless and ends its turn; none can pause for an answer. The bridge's answer is after the fact: `resume_conversation` and `task_feedback` continue the same session. |
| Run Anywhere (SSH hosts, cloud VMs, a remote Orca server) · replying to an agent from the Mobile App | Both need the bridge reachable from another machine, which needs TLS, real authentication and per-workspace isolation. The bridge is loopback-only with no auth by design (README "Security model"). |
| Automations (scheduled prompts on a repo) | The bridge's rule is that nothing starts by itself: a restart re-dispatches nothing and every task comes from a client call. A schedule belongs in the client (a cron that calls the MCP tools), where its owner sees it. |
| Git Integration (draft commits/PRs, send CI failures back) | The bridge never commits, pushes or merges for the owner. Sending a failing check back is already possible: pass its output as the `instruction` of `task_feedback`. |
| GitHub & Linear tasks | The orchestrating client already has those through its own MCP servers; the bridge receives the task text. |
| Chat or Terminal, Split Anything, Jump Anywhere, Rich Previews, Plugins, Design Mode (browser), Drag files, Dictation, Mobile Emulator, Computer Use | Desktop-app UI. The bridge's UI is a read-mostly status page; the client is where the conversation happens. |

## Agents Orca supports that could follow

Orca drives agents in a terminal, so its list is not proof of a headless mode. An adapter here needs a non-interactive run that reads the prompt from stdin or a file, a parseable final result, and a way to refuse instead of prompting. Before adding one, measure those three on the real CLI the way `src/agents/claude.ts` records it — Gemini CLI, Cursor (`cursor-agent -p`), Qwen Code and GitHub Copilot CLI are the likeliest next candidates.
