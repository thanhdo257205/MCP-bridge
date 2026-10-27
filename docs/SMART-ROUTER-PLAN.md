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
