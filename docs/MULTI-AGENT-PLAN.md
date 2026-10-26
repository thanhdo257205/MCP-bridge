# Kế hoạch: MCP Bridge đa agent (Orchestrator + Agent Router)

Trạng thái: Phase 1 hoàn tất (2026-10-26); Phase 2 là bước tiếp theo.
Cập nhật: 2026-10-26.

## 1. Mục tiêu

Biến `agy-mcp-bridge` từ cầu nối một chiều "Codex/Claude → Antigravity" thành một
**bộ định tuyến agent cục bộ**: một AI agent chính (orchestrator) chạy bridge và
giao việc cho nhiều CLI agent khác nhau, mỗi agent có thể mạnh ở một vai trò riêng.

Nguyên tắc:

- Một bridge duy nhất, nhiều backend CLI (adapter).
- Người dùng chọn thứ tự ưu tiên CLI.
- Chạy song song là mặc định **khi có cách ly**; không có cách ly thì xếp hàng tuần tự.
- Agent không được chạm vào việc của agent khác.
- Tự duyệt trong phạm vi chính sách; các hành động nguy hiểm vẫn bị chặn cứng.
- Tiết kiệm token: giao việc bằng tham chiếu file, context pack, review theo diff.

## 2. Kiến trúc

```
┌──────────────────────────────────────────────────────────────┐
│ Orchestrator (một AI agent chạy trên máy người dùng)         │
│  - nhận mission, chia plan, chọn role + CLI                  │
│  - gọi MCP tools của bridge                                  │
└──────────────────────────────┬───────────────────────────────┘
                               │ Streamable HTTP (127.0.0.1)
┌──────────────────────────────▼───────────────────────────────┐
│ agy-mcp-bridge                                               │
│  ┌──────────────┐  ┌───────────────┐  ┌───────────────────┐  │
│  │ Tool API     │→ │ Agent Router  │→ │ Adapter Registry  │  │
│  │ (MCP + UI)   │  │ plan/policy   │  │ agy, codex, ...   │  │
│  └──────────────┘  └───────┬───────┘  └───────────────────┘  │
│                            │                                  │
│  ┌─────────────────────────▼──────────────────────────────┐   │
│  │ TaskManager: queue, lock, timeout, output cap, history │   │
│  │ Isolation: git worktree + ownership manifest           │   │
│  └────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 Agent Adapter

Mỗi CLI được bọc bởi một adapter cùng hợp đồng:

```ts
interface AgentAdapter {
  id: string;                      // 'antigravity' | 'codex' | ...
  label: string;
  capabilities: AgentCapability[]; // code, review, test, research, long-run
  buildInvocation(task: AgentTask): Invocation;
  parseResult(raw: RawRun): Promise<AgentResult>;
}
interface AgentRuntime {
  adapter: AgentAdapter;
  status: AgentStatus;             // available, version, executable, warnings
  enabled: boolean;
  prefixArgs?: string[];           // e.g. resolved .cmd shim -> [script]
  launch?: (args: string[], cwd: string, options?: ProcessOptions) => ChildProcess;
}
```

- Detection nằm ở registry: `inspectCli` cho Antigravity, `detectCodex` chạy
  `codex --version` và `codex exec --help` rồi kiểm tra đủ cờ bắt buộc.
- `Invocation` gồm: executable, args, stdin (tuỳ chọn), resultFile (tuỳ chọn).
- `parseResult` chịu được output hỏng: luôn trả success/response/error/denied actions.
- Không adapter nào được tự ý đọc secret từ môi trường; env vẫn đi qua allowlist.

### 2.2 Vai trò

| Role | Việc chính | Token strategy |
| --- | --- | --- |
| Manager | Chia mission thành task, chọn agent, theo dõi | Chỉ nhận plan + trạng thái, không nhận full diff |
| Tech Lead | Thiết kế, review, quyết định kỹ thuật | Đọc diff + file được tham chiếu |
| Researcher | Khảo sát codebase, tìm nguyên nhân | Trả báo cáo ngắn + đường dẫn |
| Worker | Viết code trong phạm vi được giao | Context pack + danh sách file được sở hữu |
| Reviewer | Soát diff, phát hiện rủi ro | Chỉ diff + acceptance criteria |
| Tester | Chạy test, viết test | Lệnh test + output đã rút gọn |
| Integrator | Ghép nhánh, xử lý xung đột | Diff giữa các nhánh + trạng thái merge |

Orchestrator là agent chính, không nhất thiết là một role ở trên; nó dùng các
role như "hợp đồng giao việc" để giảm ngữ cảnh thừa.

### 2.3 CLI ưu tiên

Thứ tự mặc định do người dùng cấu hình, ví dụ:

```json
{
  "agents": {
    "priority": ["qoder", "codex", "antigravity", "opencode", "zcode"],
    "enabled": ["antigravity", "codex"]
  }
}
```

- Adapter không có trong `enabled` hoặc không detect được sẽ bị bỏ qua.
- Nếu task chỉ định `agent` mà agent đó không sẵn sàng: trả lỗi rõ ràng, không
  âm thầm đổi sang agent khác. Cờ `fallback: true` chưa triển khai; dự kiến ở Phase 2.

### 2.4 Cách ly song song

- Mặc định: task không có `isolation: "worktree"` chạy **tuần tự toàn cục** như hiện tại.
- Task có `isolation: "worktree"`:
  - tạo git worktree riêng tại state dir, nhánh `bridge/<taskId>`;
  - task khai báo `owns: string[]` (đường dẫn tương đối);
  - sau khi chạy, bridge so diff thực tế với `owns`; file ngoài phạm vi được báo
    trong `scope.out_of_scope` và task cần review; không tự động hợp nhất;
  - `max_parallel_worktrees` (mặc định 2, cấu hình 1–8).
- Hai lane loại trừ nhau: đang có task normal thì worktree xếp hàng và ngược lại.
- Tích hợp qua nhánh trung gian trước khi merge vào nhánh chính (Phase 5).
- Worktree giữ lại sau khi task xong để review; bridge không tự xóa branch.

### 2.5 Quyền tự duyệt

- `autonomy`: `suggest` | `auto` | `full`.
- `auto`: tự duyệt trong phạm vi `owns`, test, build, đọc file.
- `full`: như trên, nhưng vẫn **chặn cứng**: deploy/publish, xoá dữ liệu, push
  nhánh bảo vệ, đọc/ghi credential, thay đổi hệ thống ngoài workspace.
- Phase 1 truyền `autonomy` vào prompt và lưu trong hồ sơ task; `denied_actions`
  do CLI báo được ghi lại. Hàng đợi duyệt tương tác và nhật ký quyết định chi tiết
  thuộc Phase 4. Không dùng cờ bypass permission của CLI.

## 3. Bỏ xác thực token

Đã chốt: **xoá toàn bộ cơ chế bearer token** (HTTP, UI login/session, CLI, script,
config mẫu, tài liệu, test).

Giữ lại:

- Bind `127.0.0.1` (không nghe ra mạng ngoài).
- Kiểm tra `Host`/`Origin` để chống DNS rebinding và request từ trình duyệt lạ.
- Giới hạn kích thước body, timeout, allowlist workspace, allowlist env.

> **Cảnh báo mô hình tin cậy:** sau khi bỏ token, bất kỳ tiến trình nào chạy trên
> cùng máy và cùng user đều có thể gọi bridge để điều khiển agent. Chỉ dùng bridge
> trên máy cá nhân hoặc máy mà bạn kiểm soát hoàn toàn. Không mở port ra ngoài,
> không đặt sau reverse proxy công khai.

Các file bị xoá: `src/security/http-auth.ts`, `src/ui/session.ts`,
`tests/hardening-acl.test.ts`, token file trong `.bridge-state/`.
Các file được sửa: `src/index.ts`, `src/http.ts`, `src/ui/routes.ts`, `ui/app.js`,
`src/cli.ts`, `src/setup.ts`, `scripts/check.ts`, `scripts/live.ts`,
`config/codex-mcp.windows.toml`, `config/claude-mcp.http.json`, README/docs, test.

## 4. Lộ trình

### Phase 1 — Agent Router + adapter Antigravity/Codex (hoàn tất 2026-10-26)

Phạm vi:

1. Adapter interface + registry; adapter `antigravity` (giữ nguyên hành vi cũ) và
   `codex` (chạy `codex exec --json ...`, đọc JSONL + file last-message).
2. Hỗ trợ `.cmd` shim trên Windows (Codex được cài qua npm).
3. Tool `antigravity_delegate` nhận thêm `agent`, `isolation`, `owns`,
   `autonomy`; thêm tool `agents_list`.
4. Worktree isolation + ownership manifest + kiểm tra diff sau chạy.
5. UI hiển thị agent, worktree, nhánh và cảnh báo phạm vi.
6. Bỏ token auth hoàn toàn theo mục 3.
7. Test: adapter registry, fake codex, worktree song song, HTTP không token,
   Host/Origin vẫn bị chặn, toàn bộ test cũ chạy lại.

Kết quả: `npm test` xanh (125 pass, 3 skip do thiếu môi trường); test mới nằm ở
`tests/agents.test.ts` và `tests/fixtures/fake-codex.mjs`. Các tiêu chí nghiệm thu
đều có test tự động; đã xác minh `resolveCommand` với Codex npm thật
(`codex-cli 0.163.0`, shim `.cmd`). Chưa chạy lại `test:live` với Codex thật.

### Phase 2 — Mission daemon + Orchestrator skill

- Lưu mission/plan có cấu trúc; trạng thái từng bước; resume sau restart.
- Skill hướng dẫn orchestrator: chọn role, chọn agent, cắt context, ngân sách token.
- Tool: `mission_create`, `mission_status`, `mission_plan`, `mission_cancel`.
- Không cho agent tự sửa plan của agent khác; plan là dữ liệu chỉ đọc với worker.

### Phase 3 — Adapter cho OpenCode, Qoder, Zcode

- Viết adapter sau khi xác minh CLI trên máy (hiện chưa có trên PATH).
- Cùng hợp đồng adapter; test bằng fixture giả lập trước, live test sau.
- Bổ sung capability và cost profile để router chọn agent.

### Phase 4 — Auto-approve + UI điều khiển

- Trang Settings: autonomy mặc định, agent ưu tiên, max song song, ngân sách.
- Hàng đợi duyệt cho hành động ngoài chính sách.
- Nhật ký quyết định, diff theo task, nút hợp nhất nhánh.

### Phase 5 — Tích hợp và hardening

- Merge nhánh trung gian, kiểm tra xung đột, chạy test trên nhánh tích hợp.
- Soát bảo mật lại sau khi bỏ token (local trust model, path traversal, symlink).
- Tài liệu vận hành, giới hạn tài nguyên, dọn worktree mồ côi.

## 5. Rủi ro và cách giảm

| Rủi ro | Giảm thiểu |
| --- | --- |
| Agent sửa ngoài phạm vi | Ownership manifest + kiểm tra diff + review_required |
| Hai agent giẫm chân nhau | Worktree riêng, khoá theo workspace/worktree |
| Bỏ token làm lộ quyền điều khiển | Chỉ bind loopback, Host/Origin, cảnh báo rõ |
| Output CLI khác nhau | Adapter chuẩn hoá; parser chịu lỗi; giữ raw log |
| Tốn token | Context pack, tham chiếu file, review theo diff, model tiering |
| Worktree mồ côi | Dọn theo tuổi + trạng thái task; lệnh `workspaces`/`unlock` mở rộng |

## 6. Quyết định đã chốt

- Giữ tên tool `antigravity_*` ở Phase 1 để giảm thay đổi; thêm `agents_list`.
- Task thường tuần tự; chỉ task worktree được song song.
- Không tự động fallback agent khi task chỉ định agent cụ thể.
- Bỏ token hoàn toàn, không giữ chế độ "token tuỳ chọn".
- Orchestrator là agent bên ngoài bridge; bridge chỉ là hạ tầng giao việc.
