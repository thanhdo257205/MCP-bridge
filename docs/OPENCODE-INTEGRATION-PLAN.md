# Kế hoạch hỗ trợ OpenCode CLI trong MCP-Bridge

**Trạng thái:** Đã triển khai và kiểm chứng với `opencode v2.2.5` (`opencode run --format json`, prompt qua stdin, đầu ra JSONL). OpenCode mặc định tắt: thêm `opencode` vào `agents.enabled` để dùng. Phần dưới là thiết kế ban đầu; chi tiết CLI thực tế nằm trong `src/agents/opencode.ts`.  
**Mục tiêu:** Cho phép `agy-mcp-bridge` điều khiển được **OpenCode CLI** cùng lúc với `agy` (Antigravity) và `codex` (Codex). OpenCode được thêm như một **agent adapter** mới, đăng ký vào registry, hiển thị qua `agents_list` / `antigravity_environment`, và có thể nhận task qua `antigravity_delegate` (bao gồm cả profile và pool).

Không thay đổi hành vi hiện tại của antigravity và codex. OpenCode nằm trong **Phase 3** theo `docs/MULTI-AGENT-PLAN.md`.

---

## 1. Khai báo kỹ thuật

### 1.1 `AgentFamily` mở rộng (`src/agents/types.ts`)

Hiện tại:

```ts
export type AgentFamily = 'antigravity' | 'codex';
```

Sau:

```ts
export type AgentFamily = 'antigravity' | 'codex' | 'opencode';
```

`AgentCapability` giữ nguyên: `['code', 'review', 'test', 'research', 'long-run']`.

`AgentTask` đã có trường `model?`, `extraArgs?`, `promptTransport?` — đủ để OpenCode adapter dùng mà không cần sửa thêm.

### 1.2 Config schema (`src/config.ts`)

`agentProfileSchema.adapter` hiện là `z.enum(['codex', 'antigravity'])`. Thêm `'opencode'`:

```ts
export const agentProfileSchema = z.object({
  adapter: z.enum(['codex', 'antigravity', 'opencode']),
  label: z.string().min(1).max(100).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
  codex_sandbox: codexSandboxSchema.optional(),
  codex_ask_for_approval: codexApprovalSchema.optional(),
  model: z.string().min(1).max(200).optional(),
  executable: z.string().min(1).max(4096).optional()
}).strict();
```

Lưu ý: `codex_sandbox` / `codex_ask_for_approval` chỉ có nghĩa với adapter `codex`; với OpenCode chúng được bỏ qua (không báo lỗi vì schema `.strict()` chỉ từ chối field lạ, không từ chối field không dùng cho adapter đó).

Thêm vào `agentsSchema` (nếu muốn cài toàn bridge):
- `opencode_executable?: string` — đường dẫn binary OpenCode (mặc định `'opencode'`, tìm qua PATH).
- `opencode_model?: string` — model mặc định cho OpenCode.

Mẫu cấu hình (`config/workspaces.example.json`):

```json
{
  "agents": {
    "priority": ["antigravity", "codex", "opencode"],
    "enabled": ["antigravity", "codex", "opencode"],
    "opencode_executable": "opencode",
    "opencode_model": "gpt-5",
    "profiles": {
      "opencode-work": {
        "adapter": "opencode",
        "label": "OpenCode (Work)",
        "env": {
          "OPENCODE_HOME": "C:/Users/user/.opencode-work"
        },
        "model": "gpt-5"
      }
    }
  }
}
```

### 1.3 File mới: `src/agents/opencode.ts`

Tuân theo hợp đồng `AgentAdapter` + `AgentRuntime` (giống kiểu `codex.ts`).

**Adapter fields:**
- `id`: `'opencode'` (hoặc profile id nếu là profile).
- `label`: `'OpenCode'` (hoặc `profile.label`).
- `family`: `'opencode'`.
- `capabilities`: `['code', 'review', 'test', 'research', 'long-run']`.
- `buildInvocation(task)`: sinh `Invocation` (executable, args, stdin?, resultFile?, customEnv?, transport?).
- `parseResult(raw)`: parse output của OpenCode thành `AgentResult`.

**Runtime:** `opencodeAgent(command, status, options)` trả `{adapter, status, enabled, prefixArgs, launch?}`.

#### 1.3.1 `resolveCommand` cho OpenCode

Dùng `resolveCommand` hiện có từ `src/antigravity/process.js`. Hàm này đã hỗ trợ:
- Tìm qua PATH.
- Windows `.cmd` / `.bat` shim → trả `executable = process.execPath`, `prefixArgs = [script]`.
- Native `.exe` → trả `executable`, `prefixArgs = []`.

Không cần viết lại. OpenCode chỉ cần gọi `resolveCommand(settings.opencode_executable ?? 'opencode')`.

#### 1.3.2 Phát hiện CLI (`detectOpenCode`)

Viết hàm tương tự `detectCodex` trong `src/agents/codex.ts`:

```ts
export async function detectOpenCode(command: ResolvedCommand, opts: {
  cwd: string;
  extraEnvPassthrough: string[];
}): Promise<AgentStatus> {
  // Chạy `--version` và `--help` (hoặc flags tương đương của OpenCode)
  // Kiểm tra exit code 0, parse version, kiểm tra các flag bắt buộc OpenCode hỗ trợ.
  // Trả về {version, supported, executable, prefixArgs, warnings}.
}
```

**Điều kiện cần xác định bằng chạy `opencode --help` trên máy trước khi code:**
- Subcommand dùng để chạy task: `run` hay `exec`?
- Flag model: `--model` hay `-m`?
- Flag prompt: positional argument hay `--prompt` / `-p`?
- Output format: JSON đơn, JSONL, hay plain text?
- Có flag `--json` / `--output-format json` không?

#### 1.3.3 `buildInvocation`

Mẫu (điều chỉnh flags theo kết quả `opencode --help`):

```ts
buildInvocation(task: AgentTask): Invocation {
  const args: string[] = [];
  if (options.model) args.push('--model', options.model);
  args.push('run', task.prompt); // hoặc 'exec --prompt ...' tùy OpenCode
  return {
    executable: command.executable,
    args: [...command.prefixArgs, ...args],
    stdin: undefined,
    resultFile: undefined,
    customEnv: options.env,
    transport: 'argv', // hoặc 'stdin' nếu OpenCode yêu cầu
  };
}
```

Giới hạn input (tương tự antigravity/codex): task 16000 ký tự, workspace 4096, context 12000, tổng serialized 24000 — đã được áp dụng ở `delegateSchema` trong `src/security/input.ts`, adapter không cần kiểm tra lại.

#### 1.3.4 `parseResult`

OpenCode có thể xuất:
- JSONL stream (dòng cuối là `result`), hoặc
- JSON đơn lần, hoặc
- Plain text.

Mẫu xử lý chung:

```ts
async parseResult(raw: RawRun): Promise<AgentResult> {
  const text = raw.stdout ?? '';
  const stderr = raw.stderr ?? '';
  const deniedActions: AgentResult['deniedActions'] = [];

  if (isQuotaError(text + stderr)) {
    return {
      success: false, response: null, error: 'quota_exceeded',
      cliStatus: 'quota_exceeded', numTurns: null,
      deniedActions, isQuotaExceeded: true,
    };
  }

  let response: string | null = null;
  let success = false;

  try {
    const parsed = JSON.parse(text);
    response = parsed.response ?? parsed.text ?? parsed.message ?? JSON.stringify(parsed);
    success = parsed.success ?? raw.exitCode === 0;
  } catch {
    response = text.trim() || null;
    success = raw.exitCode === 0 && !!response;
  }

  return {
    success,
    response,
    error: success ? null : `OpenCode exited ${raw.exitCode}`,
    cliStatus: success ? 'completed' : `exit ${raw.exitCode}`,
    numTurns: null,
    deniedActions,
  };
}
```

Nếu OpenCode xuất JSONL, hãy dùng pattern `finalEnvelope` từ `src/antigravity/invocation.ts` (tách dòng `event === 'result'`).

#### 1.3.5 Environment

Dùng `startProcess(command.executable, args, cwd, { extraEnvPassthrough, customEnv: options.env })`. Biến `OPENCODE_HOME` (nếu có trong `profile.env`) sẽ được truyền vào qua `customEnv`, không bị lọc bởi `childEnvironment`.

### 1.4 Registry (`src/agents/registry.ts`)

Thay đổi:

1. `KNOWN = ['antigravity', 'codex', 'opencode'] as const`.
2. `DEFAULT_PRIORITY = ['antigravity', 'codex', 'opencode']`.
3. `DEFAULT_ENABLED = ['antigravity', 'codex', 'opencode']`.
4. Import `opencodeAgent` từ `./opencode.js`.
5. Sau khối codex, thêm khối opencode tương tự (resolve command → detectOpenCode → push `opencodeAgent`).
6. Trong vòng lặp `settings.profiles`, thêm nhánh `adapterType === 'opencode'` tương tự nhánh antigravity (hỗ trợ `profile.executable`, `profile.model`, `profile.env`).

Hàm `publicAgents` không cần sửa — nó map tự động từ `adapter.id` / `adapter.label`.

### 1.5 Task Manager (`src/tasks/manager.ts`)

Không cần sửa logic lớn. `selectAgent` đã dùng `this.agents` (mảng `AgentRuntime`) và tìm theo `adapter.id`. Vì OpenCode đã được push vào `agents` trong registry, nó sẽ tự tham gia:
- Default agent selection (theo `priority`).
- Named agent selection (`agent: 'opencode'`).
- Pool selection (nếu `opencode` là member của pool).

`AgentTask.model` đã có sẵn để truyền model per-task nếu cần.

### 1.6 HTTP / MCP / UI

Không cần sửa route. `agents_list` và `antigravity_environment` đọc từ `publicAgents(agents)` — OpenCode sẽ xuất hiện tự động với `id: 'opencode'`, `label: 'OpenCode'`, `capabilities`, `warnings`.

Web UI (`ui/app.js`) đọc cùng dữ liệu — không cần sửa nếu UI chỉ render danh sách agents generically. Nếu UI có hard-code tên antigravity/codex ở chỗ nào, cần kiểm tra và thêm opencode.

### 1.7 Kiểm thử

| Test | Nội dung |
|------|----------|
| `tests/agents.test.ts` | `opencodeAdapter.buildInvocation` sinh args đúng; `parseResult` xử lý exit 0 / exit non-zero / JSON / plain text / quota error. |
| `tests/agent-profiles.test.ts` | Profile `opencode-work` được tạo runtime, xuất hiện trong `publicAgents`, `enabled` / `disabled` đúng theo config. |
| `tests/smart-pool.test.ts` (tuỳ chọn) | OpenCode làm member của pool, failover khi quota error. |
| Live (tuỳ chọn) | Chạy `opencode --version` / `--help` thật, probe thành công. |

Không sửa test hiện có của antigravity/codex.

### 1.8 Rủi ro và hạn chế

1. **Chưa biết flags chính xác của OpenCode**. `buildInvocation` và `parseResult` ở trên là skeleton. Phải chạy `opencode --help` và `opencode run --help` (hoặc `exec`) trên máy thực tế để sửa flags (`run` vs `exec`, `--model`, output format…).
2. **OpenCode có thể không có `--json` / `--output-format`** như antigravity. Nếu xuất plain text, `parseResult` sẽ suy luận success từ exit code — ít chính xác hơn.
3. **Không có verified version list** như antigravity (`VERIFIED_AGY_VERSIONS`). Có thể thêm `VERIFIED_OPENCODE_VERSIONS` sau khi biết version scheme của OpenCode.
4. **Môi trường**: OpenCode có thể cần `OPENCODE_HOME` hoặc `ANTHROPIC_API_KEY` — truyền qua `profile.env` + `extra_env_passthrough` nếu cần.
5. **Pool**: Nếu OpenCode là member pool, mỗi profile chỉ được thử 1 lần per task (theo quy tắc hiện tại của smart-pool).

---

## 2. Thứ tự triển khai (khi được phê duyệt tài liệu này)

1. Chạy `opencode --help` và `opencode run --help` (hoặc `exec`) để xác nhận flags.
2. Sửa `src/agents/types.ts` (thêm `'opencode'` vào `AgentFamily`).
3. Sửa `src/config.ts` (thêm `'opencode'` vào `agentProfileSchema.adapter`, thêm `opencode_executable` / `opencode_model` nếu cần).
4. Tạo `src/agents/opencode.ts` đầy đủ.
5. Sửa `src/agents/registry.ts` (đăng ký OpenCode + profile nhánh opencode).
6. Cập nhật `config/workspaces.example.json` với ví dụ OpenCode.
7. Viết test cho adapter mới.
8. Chạy `npm test` và `npm run build`.

---

## 3. Câu hỏi cần trả lời trước khi bắt đầu code

1. **Flags của OpenCode là gì?** (`run`, `exec`, `--model`, output format…). Nếu bạn chưa biết, tôi có thể để skeleton và bạn sau điền chính xác sau khi chạy `opencode --help`.
2. **OpenCode được thêm vào `DEFAULT_ENABLED` và `DEFAULT_PRIORITY` ngay, hay để tắt mặc định (opt-in)?**
3. **Bạn muốn tôi lưu file này vào repo ngay, hay chỉ thảo luận tại đây?**

Khi bạn đồng ý spec và trả lời các câu hỏi trên, tôi sẽ bắt đầu viết code.