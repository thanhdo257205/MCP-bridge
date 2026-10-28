# Kế hoạch: Bộ Định Tuyến Tài Khoản Thông Minh & Tự Động Failover (Smart Pool & Quota Routing)

- **Mục tiêu**: Tự động đánh giá độ khó của task và tình trạng quota của từng profile CLI để định tuyến tài khoản phù hợp; tự động chuyển sang tài khoản dự phòng khi tài khoản hiện tại cạn quota (tương tự cơ chế 9router / LiteLLM).
- **Nhánh thực hiện**: `antigravity`
- **Ngày lập**: 2026-10-27

---

## 1. Yêu cầu nghiệp vụ

1. **Phân loại Task Dễ / Khó (Task Difficulty Classification)**:
   - Task khó:
     - Số lượng file cần sửa (`owns`) $\ge 3$.
     - Số tiêu chí nghiệm thu (`acceptance_criteria`) $\ge 4$.
     - Độ dài yêu cầu + ngữ cảnh (`task + context`) $> 3000$ ký tự.
     - Chứa từ khóa phức tạp: `refactor`, `architecture`, `concurrency`, `tối ưu`, `bảo mật`, `redesign`.
     - `timeout_seconds >= 600` hoặc reasoning effort là `high`.
   - Nếu phát hiện là task khó, ưu tiên giao cho profile VIP/mạnh (`hard_task_profile`), tránh giao cho tài khoản phụ sắp cạn quota.

2. **Theo dõi trạng thái Quota & Cooldown**:
   - Bắt các lỗi cạn quota / rate limit từ output của CLI:
     - `insufficient_quota`, `rate_limit`, `quota exceeded`, `credits exhausted`, `billing`, `too many requests`.
   - Khi một profile gặp lỗi quota, tự động đưa vào danh sách **cooldown** trong thời gian cấu hình (mặc định 15 phút).

3. **Cơ chế Tự Động Luân Chuyển (Auto Failover)**:
   - Khi một task được giao cho một **Agent Pool**:
     - TaskManager chọn profile tối ưu (dựa trên độ khó của task và danh sách cooldown).
     - Nếu trong quá trình thực thi, profile được chọn trả về lỗi `isQuotaExceeded`:
       - TaskManager đánh dấu cooldown cho profile đó.
       - Tự động lấy profile kế tiếp còn quota trong pool để thực thi lại task.
       - Trả về kết quả hoàn thành liền mạch cho Client.

---

## 2. Thiết kế Cấu trúc Dữ liệu

### 2.1. Cấu hình Pool trong `src/config.ts`

```ts
export const poolSchema = z.object({
  strategy: z.enum(['quota-adaptive', 'priority-failover', 'round-robin']).default('quota-adaptive'),
  members: z.array(z.string().min(1).max(64)).min(1).max(50),
  hard_task_profile: z.string().min(1).max(64).optional(),
  quota_cooldown_seconds: z.number().int().min(10).max(86400).default(900)
}).strict();

export type PoolConfig = z.infer<typeof poolSchema>;
```

### 2.2. Module Đánh giá & Quota Tracker (`src/agents/quota.ts`)

- `isHardTask(input: DelegateRequest): boolean`
- `isQuotaError(text: string): boolean`
- `class ProfileHealthTracker`:
  - `markCooldown(profileId: string, durationSeconds: number): void`
  - `isAvailable(profileId: string): boolean`
  - `selectProfile(pool: PoolConfig, isHard: boolean, availableAgents: string[]): string | null`

### 2.3. Cập nhật `src/agents/types.ts`

- Trong `AgentResult`: bổ sung trường `isQuotaExceeded?: boolean;`.

### 2.4. Cập nhật Adapter `codex.ts` & `antigravity.ts`

- Trong `parseResult`:
  - Nếu stderr/error hoặc response khớp `isQuotaError()`, gán `result.isQuotaExceeded = true`.

### 2.5. Cập nhật `src/tasks/manager.ts`

- Khi `delegate()` nhận target là một `pool`:
  - Chọn profile ban đầu thông qua `ProfileHealthTracker.selectProfile()`.
  - Thực thi task.
  - Nếu kết quả trả về `result.isQuotaExceeded === true` và pool còn profile dự phòng:
    - Log cảnh báo failover.
    - Chuyển sang profile tiếp theo và tái thực thi ngay lập tức.

---

## 3. Tiêu chuẩn Nghiệm thu (Test Criteria)

1. `tests/smart-pool.test.ts`:
   - Hàm `isHardTask` nhận diện chính xác các task khó theo tiêu chí số files, tiêu chí, độ dài và từ khóa.
   - Hàm `isQuotaError` nhận diện chính xác các lỗi rate-limit / quota của OpenAI và Gemini.
   - `ProfileHealthTracker` quản lý cooldown chính xác theo thời gian.
   - Kiểm tra luồng failover: Mô phỏng profile A trả về lỗi quota, TaskManager tự động gọi profile B và trả về kết quả thành công mà task không bị fail.

---

## 4. Trạng thái sau khi duyệt (2026-10-28) — kế hoạch khác gì bản đã ship

Phần lớn mục 2 đã nằm trong `main` (0.1.23): `src/agents/quota.ts`, `pools` trong `src/config.ts`,
`AgentResult.isQuotaExceeded`, `parseResult` của hai adapter và luồng failover trong `TaskManager`.
Bảng dưới ghi lại **chỗ tài liệu này nói một đường, code làm một nẻo** — đọc mục này trước khi tin mục 1–2.

| Mục kế hoạch | Thực tế đã ship |
|---|---|
| §1.1 `task + context > 3000` ký tự | `isHardTask` dùng `>= 3000` (điều kiện `fullText.length >= 3000`) |
| §1.1 từ khóa khó: 6 từ | `HARD_KEYWORDS` hiện 11 mẫu: `refactor, architecture, concurrency, tái cấu trúc, bảo mật, tối ưu, redesign, deadlock, race condition, migration, distributed` |
| §1.1 `reasoning effort là high` | **Không có tác dụng**: `delegateSchema` (`src/security/input.ts:9-19`) không có field `effort`, và schema `.strict()` nên client gửi thêm cũng bị từ chối; `input.effort === 'high'` vì thế chỉ đúng khi gọi `isHardTask` trực tiếp trong test. Effort thật đến từ `effort.json` — cài đặt **toàn bridge của chủ máy** (`src/tasks/manager.ts:251`), không phải tín hiệu per-task. Muốn dùng thì phải thêm field vào schema delegate — chưa làm |
| §1.3 "trả về kết quả hoàn thành liền mạch cho client" | Failover **có trần**: mỗi profile trong pool chỉ được thử **một lần mỗi task** (`entry.poolTried` loại profile đã đốt), pool N thành viên → tối đa N−1 retry; hết thành viên lành thì task **`failed`**, không quay vòng. Attempt bị bỏ được lưu trong `attempts[]` (agent, error, exit code, log tails cắt ở 4000 ký tự), và `summary()` cắt field này |
| §2.2 `selectProfile(pool, isHard, availableAgents)` | Chữ ký thật có thêm tham số thứ tư `exclude: ReadonlySet<string>`; trả `null` khi không còn thành viên lành, và **caller phải fail task** chứ không loop |
| §2.1 ba `strategy` (`quota-adaptive`, `priority-failover`, `round-robin`) | Schema nhận cả ba nhưng **hành vi đang như nhau**: cả ba đều trả thành viên lành đầu tiên theo thứ tự pool; `round-robin` vẫn chỉ là stub, đúng như comment ở dòng 94 của `src/agents/quota.ts`. Chưa có chiến lược thật nào khác |
| §2.1 `hard_task_profile` | Chỉ được chọn khi task **khó** *và* profile đó *đang lành và thuộc pool*; ngược lại pool bỏ qua nó |
| §1.2 cooldown "mặc định 15 phút" | Khớp: `quota_cooldown_seconds` default 900. Nhưng tracker là **in-memory singleton** (`globalHealthTracker`): restart bridge **xóa toàn bộ cooldown**, nên một tài khoản vừa cạn quota sẽ được chọn lại ngay sau khi restart |
| §1.2 "bắt các lỗi cạn quota từ output" | Danh sách pattern rộng hơn nhiều (thêm `model_capacity`, `resource_exhausted`, `overloaded`, `credit limit`, `check your plan and billing`, `exceeded your current quota` và cả `/\b429\b/`), quét **cả stdout lẫn stderr**. Hệ quả đã ghi ở `docs/HANDOFF.md` mục 6.4: agent chỉ cần *kể lại* chữ đó là profile bị cooldown oan 15 phút |
| (chưa bàn) | Task chạy bằng pool vẫn báo `task.agent` là **profile thật** chứ không phải id pool, và khi pool **hết sạch thành viên lành ngay lúc delegate** thì `selectAgent` rơi xuống nhánh "agent lạ" và báo `Unknown agent "<id-pool>"` — message gây hiểu nhầm, vì pool có tồn tại, chỉ hết tài khoản lành |
| (chưa bàn) | Với task `isolation: worktree`, retry **dùng lại đúng worktree đó** (`entry.worktreeInfo` đã cache): sửa dở của attempt bị bỏ vẫn còn trong diff, và `scope` cuối cùng là của **tổng** hai attempt cộng lại |

Còn mở, xếp theo thứ tự đáng làm: (1) một chiến lược pool thật thay vì stub, hoặc bỏ hẳn enum khỏi schema;
(2) nói cho client biết "pool hết thành viên lành" thay vì `Unknown agent`; (3) nối `effort` (hoặc bỏ điều kiện chết);
(4) persistence cooldown qua restart; (5) live-test đốt quota thật bằng hai profile đăng nhập thật — hiện hai test
`fakeProfile()` là bằng chứng duy nhất; (6) `fallback: true` khi agent được chỉ định không sẵn sàng (mòn từ Phase 1).
