# Kế hoạch: Quản lý Agent Profiles, Multi-Account & Sandbox Permission cho CLI

- **Mục tiêu**: Cho phép mỗi CLI agent (Codex, Antigravity, ...) có thể hoạt động với nhiều phiên đăng nhập riêng biệt (ví dụ: `CODEX_HOME` trỏ tới các thư mục tài khoản khác nhau), đồng thời hỗ trợ cấu hình sandbox level (`workspace-write` vs `danger-full-access`) và chính sách approval (`on-request`, `never`) do chủ máy kiểm soát an toàn.
- **Cờ đã đo trên codex-cli 0.163.0** (`codex --help`, `codex exec --help`): `--sandbox` nhận đúng ba giá trị `read-only | workspace-write | danger-full-access` và là cờ của `exec`; `--ask-for-approval` nhận đúng hai giá trị `on-request | never` và là cờ **global**, phải đặt trước `exec` — `codex exec --ask-for-approval never` thoát với `unexpected argument '--ask-for-approval'`.
- **Nhánh thực hiện**: `antigravity`
- **Ngày lập**: 2026-10-27

---

## 1. Yêu cầu & Bối cảnh

1. **Nhu cầu phiên đăng nhập độc lập (Multi-account profiles)**:
   - Người dùng thường có nhiều tài khoản (tài khoản công việc công ty, tài khoản cá nhân, tài khoản phụ của team).
   - Codex lưu thông tin đăng nhập và cache tại `CODEX_HOME` (mặc định `%USERPROFILE%\.codex` hoặc `~/.codex`).
   - Antigravity lưu tại `%USERPROFILE%\.gemini` (hoặc cấu hình qua biến môi trường).
   - Hiện tại bridge chỉ chạy 1 CLI duy nhất cho mỗi loại adapter, và lọc sạch biến môi trường khi spawn tiến trình con (hàm `childEnvironment` trong `src/antigravity/process.ts` xóa các biến lạ). Do đó, `CODEX_HOME` bị nuốt mất nếu không được cấu hình tường minh.

2. **Nhu cầu cấu hình Sandbox & Approval cho Codex**:
   - `codex exec` hỗ trợ các cờ sandbox: `--sandbox workspace-write` (mặc định), `--sandbox danger-full-access`, `--sandbox read-only`.
   - Cờ xác nhận là cờ global của `codex`, không phải của `exec`: `codex --ask-for-approval on-request|never exec ...`.
   - Mặc định bridge đang gán cứng `--sandbox workspace-write` để bảo vệ an toàn cho máy tính người dùng.
   - Khi người dùng cần giao các tác vụ hệ thống hoặc tác vụ rộng hơn phạm vi workspace mà chấp nhận rủi ro, cần có cơ chế cấu hình cấp quyền này một cách tường minh từ phía Owner (chủ máy), kèm theo cảnh báo rõ ràng trên UI và logs, không để client tự ý bypass.

---

## 2. Thiết kế Cấu trúc Cấu hình (`config/workspaces.json`)

Bổ sung trường `profiles` và các cờ sandbox tùy chọn vào schema `agents`:

```json
{
  "agents": {
    "priority": ["codex-work", "antigravity", "codex-personal"],
    "enabled": ["codex-work", "antigravity", "codex-personal"],
    
    // Cấu hình mặc định cho adapter codex
    "codex_executable": "codex",
    "codex_model": "gpt-5-turbo",
    "codex_sandbox": "workspace-write",
    "codex_ask_for_approval": "on-request",

    // Danh sách các profile độc lập
    "profiles": {
      "codex-work": {
        "adapter": "codex",
        "label": "Codex (Work Account)",
        "env": {
          "CODEX_HOME": "C:\\Users\\user\\.codex-work"
        },
        "codex_sandbox": "danger-full-access",
        "codex_ask_for_approval": "never"
      },
      "codex-personal": {
        "adapter": "codex",
        "label": "Codex (Personal Account)",
        "env": {
          "CODEX_HOME": "C:\\Users\\user\\.codex-personal"
        },
        "codex_sandbox": "workspace-write"
      },
      "antigravity-team": {
        "adapter": "antigravity",
        "label": "Antigravity (Team Account)",
        "env": {
          "GEMINI_CLI_HOME": "C:\\Users\\user\\.gemini-team"
        }
      }
    }
  }
}
```

---

## 3. Các thay đổi kỹ thuật chi tiết

### 3.1. `src/config.ts` (Config Schema)
- Định nghĩa `profileSchema`:
  - `adapter`: `'codex' | 'antigravity'` (sau này có thể mở rộng `opencode`, `qoder`).
  - `label`: Nhãn mô tả (string).
  - `env`: Record các cặp key-value biến môi trường sẽ được truyền trực tiếp vào tiến trình khi chạy agent này (ví dụ `CODEX_HOME`).
  - `codex_sandbox`: `'workspace-write' | 'danger-full-access' | 'read-only'`.
  - `codex_ask_for_approval`: `'on-request' | 'never'`.
  - `model`: Model override riêng cho profile này.
  - `executable`: Đường dẫn binary riêng nếu khác binary mặc định.
- Bổ sung `profiles: z.record(profileSchema).optional()` vào `agentsSchema`.
- Hỗ trợ các cờ global `codex_sandbox` và `codex_ask_for_approval`.

### 3.2. `src/antigravity/process.ts` (Process Spawning & Environment)
- Mở rộng `ProcessOptions`:
  ```ts
  export interface ProcessOptions {
    extraEnvPassthrough?: string[];
    stdin?: string;
    customEnv?: Record<string, string>;
  }
  ```
- Trong `startProcess()`:
  ```ts
  const env = {
    ...childEnvironment(process.env, options.extraEnvPassthrough),
    ...(options.customEnv ?? {})
  };
  ```
- Nhờ đó, bất kỳ biến môi trường nào được chỉ định trong profile (như `CODEX_HOME`) sẽ được nạp an toàn vào tiến trình con của agent mà không bị hàm lọc mặc định loại bỏ.

### 3.3. `src/agents/types.ts` & `src/agents/codex.ts`
- Cập nhật `Invocation`:
  - Thêm `customEnv?: Record<string, string>`.
- Cập nhật `CodexOptions`:
  - Bổ sung `sandbox?: 'workspace-write' | 'danger-full-access' | 'read-only'`.
  - Bổ sung `askForApproval?: 'never' | 'auto' | 'always'`.
  - Bổ sung `env?: Record<string, string>`.
- Trong `codexAdapter.buildInvocation(task)`:
  - Sử dụng `options.sandbox ?? 'workspace-write'`.
  - Thêm `--ask-for-approval <mode>` vào trước `exec` nếu profile có đặt (đặt sau `exec` thì CLI từ chối).
  - Trả về `customEnv: options.env`.

### 3.4. `src/agents/registry.ts` (Agent Registry)
- Quét danh sách `config.agents.profiles`:
  - Khởi tạo adapter tương ứng (`codex` hoặc `antigravity`) cho từng profile.
  - Định danh agent id theo tên profile (ví dụ `codex-work`).
  - Kiểm tra nếu agent được cấu hình `codex_sandbox === 'danger-full-access'` hoặc `codex_ask_for_approval === 'never'`, ghi nhận cảnh báo bảo mật:
    `Agent "${id}" is configured with danger-full-access / unapproved execution.`
  - Cảnh báo này sẽ hiển thị trong `agents_list` và Web UI để Tech Lead / Client luôn nhận biết được mức độ rủi ro.

### 3.5. `src/tasks/manager.ts`
- Khi spawn process cho task (`startProcess`):
  - Truyền `customEnv: invocation.customEnv` vào `options` của tiến trình con.

---

## 4. Kế hoạch Kiểm thử & Tiêu chuẩn nghiệm thu (Acceptance Criteria)

1. **Test Schema Config**:
   - `config.test.ts`: Parse thành công config mẫu có `profiles` và các cờ sandbox/approval.
   - Từ chối các giá trị sandbox/approval không hợp lệ.
2. **Test Environment Injection**:
   - Khởi chạy một tiến trình agent profile có `env: { CODEX_HOME: '...' }`, kiểm chứng tiến trình con thực sự nhận được biến môi trường này.
3. **Test Invocation Args**:
   - Khi cấu hình `codex_sandbox: "danger-full-access"` và `codex_ask_for_approval: "never"`, `buildInvocation` tạo ra `--ask-for-approval never` trước `exec` và `--sandbox danger-full-access` sau đó.
4. **Test Đa Profile trong Registry**:
   - `createAgentRegistry` trả về cả agent mặc định và các agent profile tùy chỉnh.
   - `agents_list` thể hiện đúng id, label, capabilities và các cảnh báo an toàn tương ứng.
5. **Không gây hồi quy (No regression)**:
   - Các cấu hình cũ không dùng profile vẫn chạy chính xác như trước.
