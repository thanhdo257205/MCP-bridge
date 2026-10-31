# Hàng đợi duyệt cho hành động ngoài chính sách (Phase 4) — điều tra và thiết kế

**Trạng thái:** B2 đã cài đặt theo thiết kế "duyệt sau" sau khi chủ dự án duyệt; những chỗ khác thiết kế và bằng chứng kiểm thật nằm ở mục 9. Các mục 1–8 là điều tra và thiết kế gốc, giữ nguyên.

`docs/MULTI-AGENT-PLAN.md` (Phase 4) ghi "hàng đợi duyệt cho hành động ngoài chính sách". Điều chưa ai biết là **agent có dừng lại chờ duyệt giữa chừng được không**. Tài liệu này đo điều đó trên máy thật, rồi thiết kế đúng theo những gì đo được.

## 1. Kết luận ngắn

1. **Không CLI nào mà bridge dùng cho phép duyệt giữa chừng** trong chế độ không tương tác. Đo được trên `codex` và `opencode`; `agy` chưa đo lại được (mục 2.1).
   - `codex exec`: không có sự kiện "xin quyền" nào, cả với `on-request` lẫn `never`. Hành động bị sandbox chặn chỉ hiện ra là một lệnh **thất bại** (`status: failed`, "Access ... is denied").
   - `opencode run`: khi `permission` là `ask`, lời xin bị **tự từ chối ngay** (`auto-rejecting`) và run đi tiếp.
2. Vì vậy MVP trung thực là **duyệt sau, không duyệt giữa chừng**: task kết thúc mà có hành động bị từ chối thì vào hàng đợi; chủ bridge chọn **"Cho phép và chạy lại"** (tạo task mới, `retry_of`, với quyền cao hơn *đúng cho một lần chạy đó*) hoặc **"Bỏ qua"**.
3. **Bridge hôm nay chỉ nhìn thấy sự từ chối của `agy`** (`denied_actions`). `codex` chỉ được nhận diện khi item có status `declined`/`denied`, mà **chưa từng thấy** trong các lần đo; `opencode` báo `deniedActions: []` cố định dù có tín hiệu rõ ràng. Hàng đợi chỉ có nghĩa khi hai adapter này được dạy nhận ra sự từ chối (mục 4).
4. Có cờ để nâng quyền **hẹp, một lần**: `codex --add-dir <dir>` (đã đo), `agy --mode accept-edits` (từ help, chưa đo), `opencode` qua `OPENCODE_CONFIG_CONTENT` theo từng lần chạy (cơ chế đã đo, tác dụng lên đúng quyền chưa đo).

## 2. Đo đạc

Máy: Windows 11, `agy` 1.4.12, `codex-cli` 0.163.0 (đăng nhập ChatGPT, `~/.codex/config.toml` có `[windows] sandbox = "elevated"`), `opencode` v2.2.5. Mọi lần đo chạy trong một repo git **tạm** (`%TEMP%\approval-probe-*\ws`, một commit `a.txt`), thư mục "ngoài workspace" là thư mục tạm riêng; không chạy agent trên repo của người dùng. Hai thư mục tạm trong thư mục home (để nằm ngoài `%TEMP%`) đã được xóa sau mỗi lần.

### 2.1 `agy` — chưa đo được ở 1.4.12

```
agy --version                                         → 1.4.12
agy --print "Reply with exactly: PROBE_OK" --output-format json
→ Authentication required. Please visit the URL to log in: https://accounts.google.com/o/oauth2/auth?...
```

`agy` chưa đăng nhập trên máy này và việc đăng nhập là của chủ máy, nên mọi điều dưới đây về `agy` là **cờ đọc từ `agy --help`** hoặc **bằng chứng đã ghi trước đây**, không phải số đo mới:

- Cờ (từ `agy --help`): `--mode accept-edits|auto|plan`, `--dangerously-skip-permissions` ("Auto-approve all tool permission requests without prompting"), `--sandbox` ("terminal restrictions"), `--output-format json`.
- Bằng chứng đã ghi (`docs/VERIFICATION.md`, mục 4, trên `agy` 1.4.x trước đây): yêu cầu tạo file trong scratch workspace → CLI trả `SUCCESS`/exit 0 nhưng `denied_actions` chứa `write_file`, response rỗng; bridge báo `failed`.
- Adapter hiện tại (`src/agents/antigravity.ts:39-44, 54-55`) đọc `envelope.denied_actions` (tối đa 100 mục, `action` và `display_name`) và biến task thành lỗi `Required tool permissions were denied; …`.

**Chưa biết:** hình dạng `denied_actions` cho hành động khác `write_file` (chạy lệnh, đọc ngoài workspace); mức `--mode` nào mở được loại hành động nào; hành vi trên 1.4.12.

### 2.2 `codex` 0.163.0

Lệnh (cờ `--ask-for-approval` là cờ toàn cục, đứng **trước** `exec`):

```
codex --ask-for-approval <on-request|never> exec --json --sandbox <mode> --skip-git-repo-check --ephemeral --cd <ws> --color never -   (prompt qua stdin)
```

| # | Chính sách | Hành động yêu cầu | Kết quả đo |
|---|---|---|---|
| c4 | `never`, `read-only` | ghi `inside.txt` trong workspace | `command_execution` **`failed`**, exit 1, `Access to the path '…\ws\inside.txt' is denied`. Codex thoát 0, `turn.completed`, agent tự kể lại lỗi |
| c2 | `on-request`, `workspace-write` | ghi `../outside/out.txt` (dưới `%TEMP%`) | **thành công**, exit 0 |
| c3 | `never`, `workspace-write` | như c2 | **thành công**, exit 0 |
| d1 | `on-request`, `workspace-write` | ghi file dưới thư mục home, **ngoài `%TEMP%`** | `failed`, exit 1, `Access … is denied`; file không tạo |
| d2 | `never`, `workspace-write` | như d1 | `failed`, exit 1, như d1 |
| e1 | `never`, `workspace-write --add-dir <A>` | ghi vào `A` và vào thư mục `B` không nêu tên | `A`: **thành công**; `B`: `failed`, exit 1, `Access … is denied` |
| c1 | `on-request`, `workspace-write` | ghi `inside.txt` trong workspace | cả hai lần thử: `failed`, exit −1, `Failed to create unified exec process: orchestrator_helper_exit_nonzero: setup helper exited with status Some(143)` — lỗi hạ tầng của sandbox Windows, **không** phải từ chối quyền; chỉ xảy ra ở lần này, c2/c3 chạy ngay sau đó bình thường |

Điều rút ra:

- **Không có sự kiện xin quyền trong JSONL.** Các loại sự kiện thấy được: `thread.started`, `turn.started`, `item.started|completed` (`agent_message`, `command_execution`, `error`), `turn.completed`. `on-request` và `never` cho cùng kết quả trong `exec`: lệnh bị chặn thất bại ngay, "Execution failures are immediately returned to the model" đúng như `--help`.
- **Không thấy `status: declined`/`denied` nào.** Điều kiện của adapter (`src/agents/codex.ts:62-63`) không bao giờ đúng với kiểu từ chối này, nên task kết thúc `completed` với câu trả lời của agent ("The write … was refused") và `denied_actions: []`. Bridge **không phân biệt được** "agent làm xong" với "agent bị chặn và kể lại".
- `workspace-write` **cho ghi vào thư mục tạm** (c2, c3) nhưng **không** cho ghi vào thư mục home ngoài workspace (d1, d2). Hai điều này cho thấy "ngoài workspace" của codex không đồng nghĩa với "ngoài `%TEMP%`" (suy ra từ hai nhóm kết quả, không phải từ tài liệu).
- `--add-dir <dir>` mở **đúng** thư mục nêu tên (e1) — đây là cách nâng quyền hẹp nhất cho "ghi ngoài workspace".
- `--sandbox danger-full-access` **không đo**: chạy một agent không có sandbox nằm ngoài phạm vi cuộc điều tra này. Chỉ biết từ `--help` rằng cờ đó tồn tại.
- Stderr của mọi lần chạy có `ERROR rmcp::transport::worker … http request failed … http://127.0.0.1:3000/mcp` (và `:8080`): codex nạp **MCP server khai báo trong `~/.codex/config.toml` của người dùng**, trong đó có chính bridge. Xem mục 7.

### 2.3 `opencode` v2.2.5

Lệnh (cách bridge chạy; cấu hình quyền đưa qua biến môi trường để không đụng file cấu hình của người dùng):

```
[OPENCODE_CONFIG_CONTENT='{"permission":{…}}'] opencode run --standalone --format json --model <free model> [--auto]   (prompt qua stdin)
```

| # | Cấu hình / cờ | Hành động yêu cầu | Kết quả đo |
|---|---|---|---|
| o1 | mặc định, không `--auto` | `printf … > inside.txt` bằng shell | `tool_use` shell **`completed`**, file tạo. **Không hỏi** |
| o2 | mặc định, không `--auto` | ghi file thư mục home, **ngoài workspace**, bằng shell | `tool_use` shell **`completed`**, file được tạo. **Không hỏi, không chặn** |
| o3 | `--auto` | như o2 | `completed`, file tạo |
| o4 | `permission: {edit: ask, bash: ask}` | ghi `inside.txt` | `tool_use` shell **`status: "error"`**, `error`: *"This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action."*; agent thử lại bằng tool `write`, cùng lỗi. Stderr: `! permission requested: shell (echo -n "IN_OK" > inside.txt, cat inside.txt); auto-rejecting` và `! permission requested: edit (inside.txt); auto-rejecting`. Run **đi tiếp**, thoát 0, agent kể lại việc bị từ chối |
| o5 | như o4 + `--auto` | như o4 | `completed`, file tạo → `--auto` **ghi đè** `ask` |
| o6 | `permission: {edit: deny, bash: deny}` | ghi `inside.txt` | shell/edit bị chặn; agent **chuyển sang tool khác**: gọi tool `execute` với các MCP tool của chủ máy (`tools.rea.*`, `tools.browser`), thử `capture_process_scenario` chạy `powershell.exe`, rồi tạo subagent. Các MCP tool đó trả `capability_unavailable` nên không có tác động; run dừng vì hết hạn mức free |

Ghi chú về các số đo: o1 chạy trên `opencode/big-pickle`, o2–o6 (và chạy lại o1, bị 429) trên `opencode/deepseek-v4.1-flash-free`, vì `big-pickle` hết hạn mức miễn phí giữa chừng (`provider.free-limit`, 429). o4 có kết quả trên cả hai model.

Điều rút ra:

- **`opencode run` không có duyệt giữa chừng.** Lời xin quyền bị tự từ chối tức thì.
- **Có tín hiệu từ chối rõ ràng và ổn định** để adapter đọc: `tool_use` có `part.state.status === "error"` và thông điệp chứa `cannot ask the user for permission`; stderr có dòng `permission requested: <tool> (<tham số>); auto-rejecting`. Adapter hiện trả `deniedActions: []` cố định (`src/agents/opencode.ts:91`).
- **Cấu hình mặc định không từ chối gì cả** (o1, o2): hàng đợi duyệt chỉ có việc để làm với OpenCode khi chủ máy đã đặt `permission` thành `ask` (hoặc `deny`) trong cấu hình của OpenCode. Đây là điểm khác lớn với `agy`/`codex`.
- **Từ chối `bash` không chặn việc chạy lệnh**: o6 cho thấy agent tìm đường khác qua MCP tool có sẵn trong cấu hình OpenCode của chủ máy. Một mức quyền chỉ nói về `bash`/`edit` là chưa đủ.
- `opencode` có `serve`, `acp`, `api` và cờ `--server <url>`; có thể có API duyệt quyền trong server. **Chưa đánh giá**, ngoài MVP.

## 3. Bridge nhìn thấy gì hôm nay

| Agent | Nguồn tín hiệu từ chối | Kết quả trong bridge |
|---|---|---|
| `agy` | `denied_actions` trong JSON cuối (`antigravity.ts:39-44`) hoặc stderr khớp `auto-denied\|soft.denied\|permission.*cannot prompt` (dòng 54) | task `failed`, `denied_actions` điền |
| `codex` | item `declined`/`denied` (`codex.ts:62-63`) — **chưa từng thấy** | sự từ chối kiểu sandbox (mục 2.2) → task `completed`, `denied_actions: []` |
| `opencode` | không đọc gì (`opencode.ts:91`) | task `completed`, `denied_actions: []` |

## 4. Việc adapter cần làm để hàng đợi có dữ liệu (thuộc B2, nếu thiết kế được duyệt)

- **opencode** (tín hiệu chắc chắn): mỗi `tool_use` có `state.status === "error"` và thông điệp khớp `/cannot ask the user for permission/` → một `denied_action` `{action: part.tool, display_name: <tham số rút gọn, đã redact>}`. Một task có `denied_actions` thì chuyển sang `failed` như `agy`, hay giữ `completed` kèm cảnh báo? **Xem câu hỏi 3.**
- **codex** (tín hiệu yếu): `command_execution` `failed` với output khớp `/access.*denied|permission denied|read-only file system/i` chỉ là **nghi ngờ** (agent có thể tự gây lỗi đó). Đề xuất: ghi vào hàng đợi như `suspected: true`, không đổi trạng thái task, và nói rõ trên giao diện rằng đó là suy đoán từ văn bản. Không dựa vào nó để tự động hóa gì.
- **agy**: giữ nguyên.

## 5. Thiết kế MVP: "duyệt sau, chạy lại một lần"

### 5.1 Luồng

1. Task kết thúc; có `denied_actions` (hoặc nghi ngờ, mục 4) → một **yêu cầu duyệt** hiện trong hàng đợi và ở panel của task.
2. Chủ bridge mở yêu cầu, thấy từng hành động bị từ chối (văn bản do CLI cung cấp, hiển thị bằng `textContent`, cắt độ dài, đã redact) và các lựa chọn:
   - **Cho phép và chạy lại**: hộp thoại chọn *mức nâng* (mặc định là mức hẹp nhất dùng được cho agent đó, xem 5.2), cảnh báo nó có thể lộ ra điều gì, và ô `confirm`. Kết quả: **task mới** `retry_of: <task cũ>`, cùng yêu cầu đã lưu, kèm `elevation` của đúng lần này.
   - **Bỏ qua**: đóng yêu cầu, không chạy gì.
3. Mọi quyết định ghi vào nhật ký (`appendDecision`): hành động `approve`/`rerun` (cho phép và chạy lại, kèm mức nâng và id task mới) và `dismiss`.

### 5.2 Quyền nâng cho đúng một lần chạy (mức hẹp nhất mà cờ cho phép)

| Agent | Mức hẹp → rộng | Mặc định | Có thể lộ ra |
|---|---|---|---|
| `agy` | `--mode accept-edits` → `--mode auto` → `--dangerously-skip-permissions` (từ `agy --help`; **chưa đo** hành động nào cần mức nào) | `accept-edits` nếu mọi hành động bị từ chối là ghi file (`write_file`, đã ghi nhận trước đây); còn lại chủ chọn tay, không đoán | `accept-edits`: sửa file trong workspace không hỏi. `auto`/`full`: lệnh và đường dẫn ngoài workspace, thông tin đăng nhập trên máy |
| `codex` | `--add-dir <thư mục>` (**đã đo**, mở đúng thư mục nêu tên) → `--sandbox danger-full-access` (**chưa đo**) | `--add-dir` cho thư mục xuất hiện trong hành động bị từ chối, khi suy ra được; ngược lại chủ nhập thư mục | `--add-dir`: ghi vào thư mục đó. `danger-full-access`: toàn bộ ổ đĩa và mạng. `--ask-for-approval` **không** giúp gì (đo: `on-request` = `never` trong `exec`) |
| `opencode` | patch quyền theo từng lần chạy qua `OPENCODE_CONFIG_CONTENT`, chỉ cho phép đúng quyền bị từ chối (ví dụ `{"permission":{"bash":"allow"}}`) → `--auto` | patch hẹp. **Chưa đo** patch này có thắng cấu hình `ask` toàn cục của người dùng không (cơ chế biến môi trường đã đo ở o4/o5; thứ tự ưu tiên thì chưa) | `bash: allow` ở OpenCode cho phép ghi **ngoài workspace** (o2) và mọi lệnh. `--auto` duyệt cả những gì cấu hình hỏi. MCP tool của chủ máy luôn nằm trong tầm với (o6) |

### 5.3 Bảo đảm quyền chỉ áp dụng cho một lần chạy

- Quyền nâng chỉ đi vào **đối số/biến môi trường của lần launch đó** (`extraArgs`/`customEnv` đã có sẵn trong `AgentTask`) và vào trường `elevation` của bản ghi task mới. **Không ghi** `permissions.json`, `workspaces.json`, cấu hình CLI hay biến môi trường của bridge; cài đặt toàn cục của chủ máy không đổi.
- Task chạy lại **không kế thừa** gì cho task sau: chạy lại một task chạy lại cần một lần duyệt mới. `retry_of` chỉ để tra cứu, không mang quyền.
- Mức nâng có **trần** là lựa chọn của chủ trong hộp thoại xác nhận; lúc launch, bridge kiểm tra lại `elevation` trên bản ghi chứ không tin giá trị nào khác (cùng tinh thần `lowerLevel` ở `permissions.ts`: không có đường nào làm quyền tăng sau khi chủ đã chọn).
- Task cũ được giữ nguyên làm bằng chứng; task mới dùng **đúng yêu cầu đã lưu của task cũ** (không lấy văn bản từ đầu ra của agent).

### 5.4 Chỉ chủ bridge duyệt, và agent không tự duyệt được

- Chỉ qua **web UI** (`POST /ui/api/…`, `confirm: true`), cùng mô hình tin cậy với "Áp dụng/Bỏ worktree" (#40) và dừng mission. **Không thêm tool MCP nào** để xem hàng đợi, duyệt hay nâng quyền; `tests/http.test.ts` và `tests/bridge.test.ts` đều đếm số tool nên thêm nhầm sẽ đỏ.
- Văn bản trong yêu cầu (tên hành động, tham số) do CLI/agent tạo ra nên **không tin cậy**: hiển thị bằng `textContent`, giới hạn độ dài, qua `redact`; không bao giờ đưa vào một câu lệnh hay vào prompt của lần chạy lại.
- Một agent không thể tạo yêu cầu duyệt cho chính nó ngoài việc bị từ chối thật, và không có đường nào từ nội dung nó viết tới nút "Cho phép".

### 5.5 Dữ liệu

Không thêm kho trạng thái mới. Yêu cầu duyệt được **suy ra** từ bản ghi task (`denied_actions`, trường mới `retry_of`/`elevation`) và từ `decisions.jsonl` (đã có, chỉ thêm giá trị `approve`/`rerun`/`dismiss` vào `DecisionAction`). Một yêu cầu là "chờ" khi task có `denied_actions` và chưa có quyết định nào cho task đó. Hệ quả: khởi động lại bridge không làm mất hàng đợi, và nhật ký vẫn là nguồn duy nhất.

### 5.6 Task `isolation: worktree`

Đề xuất: lần chạy lại tạo **worktree mới từ HEAD** (sạch), worktree cũ giữ nguyên để chủ xem và bỏ. Cái giá: mất phần việc dở của lần đầu. Phương án khác (dùng lại worktree) giữ việc dở nhưng tái hiện đúng vấn đề đã ghi ở `docs/SMART-ROUTER-PLAN.md` (phạm vi là tổng hai lần). **Xem câu hỏi 2.**

## 6. Ranh giới của MVP

Ngoài MVP và chưa kiểm: duyệt giữa chừng (API server của OpenCode chưa đánh giá); mọi thứ về `agy` 1.4.12; hình dạng `denied_actions` ngoài `write_file`; `codex --sandbox danger-full-access`; patch cấu hình OpenCode có thắng cấu hình toàn cục không; hành vi trên Linux/macOS (mọi số đo ở trên là Windows).

## 7. Quan sát ngoài phạm vi (không sửa trong PR này)

1. **OpenCode `provider.free-limit` không được nhận là hết quota.** Run bị 429 `FreeUsageLimitError` ("Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models."): `isQuotaError` trả `false` cho cả thông điệp lẫn `provider.free-limit` (đã chạy), nên một pool có OpenCode **không failover** khi hạn mức miễn phí hết.
2. **OpenCode chạy với MCP tool của chủ máy** (o6): từ chối `bash` không chặn việc thử chạy lệnh qua tool khác. Đáng cân nhắc cô lập cấu hình OpenCode của task (cấu hình riêng qua `OPENCODE_CONFIG_CONTENT`/`XDG_*`).
3. **Codex nạp MCP server của người dùng, kể cả chính bridge** (stderr mục 2.2). Khi bridge đang chạy ở cổng đó, một task `codex` do bridge giao có thể gọi lại `antigravity_delegate` — một đường đệ quy chưa được chặn. Chưa đo (trong các lần đo bridge không chạy ở cổng 3000).
4. Sandbox Windows của codex thỉnh thoảng thất bại ở khâu khởi tạo (c1, `Some(143)`); bridge sẽ thấy lệnh `failed` mà không có dấu hiệu từ chối.

## 8. Câu hỏi cần chủ dự án quyết trước khi viết mã

1. **Chấp nhận "duyệt sau"** (không duyệt giữa chừng) làm MVP? Đây là kết luận của các số đo ở mục 2.
2. **Task worktree chạy lại**: worktree mới từ HEAD (đề xuất) hay dùng lại worktree cũ?
3. **Task có `denied_actions` ở OpenCode/Codex**: giữ `completed` kèm cảnh báo, hay chuyển `failed` như `agy`? (Đổi trạng thái là đổi hành vi hiện tại, ảnh hưởng mission và pool failover.)
4. **Codex "nghi ngờ"** (suy ra từ văn bản): có đưa vào hàng đợi (gắn nhãn suy đoán), hay chỉ làm khi CLI báo `declined`/`denied` thật?
5. **`agy`**: đăng nhập `agy` trên máy này để đo mục 2.1 trước khi viết mã, hay chấp nhận thiết kế dựa trên bằng chứng cũ và cờ trong `--help`?
6. Có làm việc ngoài phạm vi ở mục 7 (đặc biệt mục 1, thiếu nhận diện hết hạn mức OpenCode) thành PR riêng không?

## 9. Đã cài đặt (B2): khác với thiết kế ở trên, và kiểm thật

**Chốt cho các câu hỏi ở mục 8** (chủ dự án duyệt thiết kế, các câu hỏi còn lại lấy phương án đề xuất): (1) "duyệt sau" là MVP; (2) task worktree chạy lại dùng
**worktree mới từ HEAD** (tự nhiên có được vì lần chạy lại là một task mới), worktree cũ giữ nguyên; (3) task có `denied_actions` ở OpenCode/Codex **giữ nguyên
trạng thái** (`completed` kèm hành động bị từ chối) để không đổi hành vi mission và failover; (4) codex "nghi ngờ" **có** vào hàng đợi, gắn `suspected: true` và chỉ
là suy đoán; (5) `agy` chưa đo lại (vẫn chưa đăng nhập): thiết kế dựa trên bằng chứng cũ và `--help`; (6) các quan sát ở mục 7 chưa sửa trong PR này.

**Khác với mục 5:**

- Trạng thái "đã chạy lại / đã bỏ qua" nằm **trên bản ghi task** (`approval: {state, at, task_id}`), không suy từ `decisions.jsonl` như mục 5.5 đã viết: nhật ký bị cắt
  khi dài, bản ghi task thì không, và hàng đợi còn nguyên sau khi khởi động lại bridge (đã thử).
- `dismiss` là một giá trị mới của `DecisionAction` (cùng `approve` và `rerun`).
- `codex --sandbox danger-full-access` **không** được cài đặt: chưa đo, và là mức không có sandbox. Với codex chỉ có `--add-dir <thư mục>`; hành động không phải ghi
  ngoài workspace (lệnh, mạng) thì hàng đợi chỉ cho bỏ qua.
- Quyền nâng không vượt qua họ agent: một `Elevation` của codex không bao giờ tới lần launch của opencode và ngược lại (kiểm lúc duyệt và lúc launch).
- OpenCode: một quyền cho từng lần chạy là bản vá `permission` trong `OPENCODE_CONFIG_CONTENT` của đúng lần launch đó, gộp vào cấu hình profile đã có; nếu profile đặt **một chuỗi
  cho mọi quyền** (ví dụ `"permission": "ask"`) thì từ chối thay vì làm lỏng các quyền khác.

**Kiểm thật trên giao diện** (bridge cô lập: `BRIDGE_HOME` và `ANTIGRAVITY_BRIDGE_CONFIG` tạm, cổng 3999, repo scratch; `opencode` 2.2.5 thật, model free; profile `oc-ask` có
`permission: {bash: ask, edit: ask}` trong `OPENCODE_CONFIG_CONTENT`):

1. Giao một task qua MCP (`antigravity_delegate`, agent `oc-ask`): OpenCode bị từ chối lệnh shell; task có `denied_actions` =
   `shell: cd …\ws && echo IN_OK > inside.txt` (đọc từ sự kiện `tool_use` thật). Thanh bên hiện huy hiệu **1** ở mục "Duyệt".
2. Khởi động lại bridge trên cùng thư mục: hàng đợi **còn nguyên** (yêu cầu vẫn "chờ duyệt").
3. Ở trang Duyệt chọn "Cho phép chạy lệnh shell" (mức hẹp nhất, được chọn sẵn; `--auto` hiện nhãn "rộng") và bấm "Cho phép và chạy lại". Hộp thoại xác nhận ghi rõ
   quyền, phạm vi và rằng chỉ cho một lần chạy.
4. Task mới có `retry_of` và `elevation: {kind: "opencode-allow", permission: "bash"}`; task cũ thành `approval.state = "rerun"`; nhật ký có `approve` rồi `rerun`.
   **`inside.txt` chứa `IN_OK` được tạo trong workspace** và lần chạy lại **không bị từ chối** (`denied_actions` rỗng) dù profile vẫn đặt `bash: ask`. Trang task của lần chạy
   lại hiện ghi chú "lần chạy lại của task …". Trang Duyệt chuyển yêu cầu sang "Đã xử lý" kèm liên kết tới task mới.

Điều kiểm thật tìm ra: một `null` trong mảng trả về của trang Duyệt hiện thành chữ "null" ở cuối trang (`replaceChildren` biến `null` thành văn bản); đã sửa.

**Hạn chế đã thấy khi kiểm thật (chưa xử lý):**

- Một run kết thúc vì **hết giờ hoặc bị hủy** không đọc kết quả của CLI (`parseResult` bị bỏ qua), nên các lần từ chối trong run đó **không** vào hàng đợi. OpenCode, khi bị từ chối, hay
  thử cách khác cho tới khi hết giờ (đã thấy: model tiếp tục dùng tool `execute` của MCP); chỉ dẫn "bị từ chối thì dừng và báo" trong prompt làm run kết thúc đúng lúc.
- Hạn mức miễn phí của OpenCode làm run dừng giữa chừng (`provider.free-limit`); lần từ chối trước đó vẫn được ghi lại, nhưng task `failed` vì lý do khác.
- Chưa đo: bản vá `permission` qua `OPENCODE_CONFIG_CONTENT` thắng cấu hình **toàn cục** của người dùng (chỉ thấy nó thắng cấu hình `ask` của chính profile); `agy` ở mọi khía cạnh; Linux, macOS.
