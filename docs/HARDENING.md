# Hardening — nhánh improvements/hardening

11 hạng mục được triển khai thành 11 commit riêng; không thêm dependency, vẫn Node >=20. Không push, tạo PR hay publish npm. `npm run test:live` không được chạy.

## Thay đổi hành vi cần biết

1. Workspace bỏ qua **nội dung** `node_modules` và `.git` khi quét. Link ngoài hai vùng này chỉ được chấp nhận nếu realpath nằm trong workspace; link hỏng bị từ chối. Link/junction trong đường dẫn input vẫn bị từ chối. Đây là preflight, không phải OS sandbox; vùng bỏ qua và thay link sau preflight vẫn là giới hạn.
2. Task queued được validate lại trước launch. Chuyển sang running được ghi trước spawn để restore không kết luận sai rằng task chưa từng sửa file. Recheck trạng thái ngay trước spawn ngăn launch tiếp sau cancel/shutdown trong lúc chờ I/O.
3. POSIX SIGTERM cả nhóm, tối đa 8 giây rồi SIGKILL. Windows vẫn taskkill theo PID/cây thuộc server khi hủy; khi agent tự thoát, bridge còn giải phóng các cây con mà agent để lại (mục "Dọn cây tiến trình agent" dưới đây). Bridge watchdog chạy sau CLI timeout thêm 10 giây; cancellation có thể chờ thêm thời gian cleanup.
4. Startup và acquisition tự thu hồi lock chỉ khi cả hai PID trong owner đều hợp lệ và không còn sống. Record thiếu/hỏng, PID còn sống, ownership đổi hoặc owner cũ hơn lock thì giữ nguyên. `agy-mcp-bridge unlock` dùng cùng logic và không kill process. PID reuse và server crash vẫn cần xử lý thận trọng; chưa có Windows Job Object.
5. Family 1.4.x phải có đủ cờ bắt buộc trong help. Mỗi patch 1.4.3, 1.4.7, 1.4.8 và 1.4.9 đều có một lần `npm run test:live` đạt trên CLI thật (smoke + hủy task + shutdown; 1.4.8 và 1.4.9 thêm mission ba bước); patch 1.4.x khác có cảnh báo log/environment; minor/major khác không chạy.
6. Môi trường child mặc định chỉ có PATH, HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP, TMP, TMPDIR, SystemRoot, ComSpec, LANG, LC_*, XDG_*, HTTP_PROXY, HTTPS_PROXY, NO_PROXY; tên không phân biệt hoa thường. Tên chứa TOKEN/SECRET/PASSWORD/API_KEY chỉ được truyền khi có trong `extra_env_passthrough`. Các thiết lập auth/tool phụ thuộc env khác có thể cần opt-in.
7. Bridge không có bearer token. Chỉ bind 127.0.0.1 và giữ kiểm tra Host/Origin; bất kỳ tiến trình cục bộ cùng user đều có thể điều khiển agent, hủy task hoặc tắt server. Đây là mô hình tin cậy cục bộ có chủ đích, không dùng cho máy chia sẻ hoặc mạng ngoài.
8. Prompt mặc định vẫn đi qua argv với print/json, là đường đã được chạy thật với `agy` 1.4.3, 1.4.7, 1.4.8 và 1.4.9. Chế độ `"prompt_transport": "stdin"` (tùy chọn, chưa mặc định) gửi NDJSON qua stdin để prompt không hiện trong danh sách tiến trình: một event user rồi end, stdout phải có đúng một event result hợp lệ. Chỉ bật khi đã xác nhận bằng một lần chạy `agy` thật; nếu định dạng không khớp, task fail và lỗi có gợi ý quay lại argv. Cap API 24000 ký tự và output cap không thay đổi; progress/init cũng tính vào output.
9. Output được gom vào mảng chunk; decode/redact snapshot tối đa mỗi giây, cuối task flush đầy đủ. Byte counts và truncated giữ ngữ nghĩa cũ.
10. Repeated SIGINT/SIGTERM không bỏ cleanup; in thông báo chờ.
11. Prompt nhận clientLabel thực tế; MCP/UI version đọc manifest. Prerelease được so từng phần, numeric so bằng BigInt, ví dụ rc.2 < rc.10; build metadata không ảnh hưởng precedence.

Ví dụ các key mới trong config (merge với config hiện có, không thay toàn bộ file):

```json
{
  "extra_env_passthrough": ["GOOGLE_APPLICATION_CREDENTIALS"],
  "prompt_transport": "argv"
}
```

Chỉ thêm env khi cơ chế xác thực/tool của chính bạn cần nó. `"prompt_transport": "argv"` (mặc định) gửi prompt qua command line, nên nội dung prompt hiện trong danh sách tiến trình; `"stdin"` tránh điều đó nhưng chưa được chạy thử với `agy` thật. Không tự nới quyền CLI khi gặp permission denial.

## Bằng chứng và giới hạn kiểm thử

- Chạy `npm test` sau từng commit trên Windows và kiểm tra từng snapshot commit trên Ubuntu WSL Node 20 bằng `npm test`. Test POSIX signal được bỏ qua trên Windows và thực thi trên Linux.
- Test mới bao phủ link nội bộ/ngoài workspace, queue revalidation và history transition, SIGTERM/escalation, PID lock recovery/unlock, patch-version/flag gates, env của executable giả, stdin/fallback/malformed results, snapshot throttling, repeated signals, client prompt, MCP/UI version và prerelease ordering.
- Một lần suite Windows gặp ECONNRESET trong test HTTP oversized-body có sẵn. Test riêng và suite chạy lại xanh; không nới assertion/body cap/auth để né lỗi.
- `agy --help` xác nhận `--input-format stream-json` đọc NDJSON từ stdin và cần output stream-json. Đối chiếu [tài liệu Google chính thức](https://antigravity.google/docs/cli/headless/) về user/message.content, result envelope và EOF.
- Probe CLI thật dùng **control_request cố ý không hỗ trợ**, không gửi user prompt: exit 2, result ERROR, num_turns 0, tất cả usage counters 0. Xác minh parser/đường lỗi; thành công của AI qua stdin chỉ được test bằng executable giả trong đợt này. Không tuyên bố đã kiểm thử agent thật cho patch ngoài danh sách ở mục 5, hoặc cho transport mới.
- Không thay bind 127.0.0.1 hoặc Host/Origin; không mở LAN. Bridge cố ý không có xác thực — chỉ dùng trên máy do chủ máy kiểm soát.

## Dọn cây tiến trình agent (nhánh deepseek, 2026-10-26)

Hậu quả thực tế trên Windows: process con do `agy` tự khởi động (MCP server qua `cmd /c npx -y open-figma-mcp@latest`, chrome-devtools-mcp) lấy worktree làm thư mục làm việc và sống lâu hơn agent. Windows không cho xóa hoặc đổi tên một thư mục đang được process khác giữ làm cwd, nên worktree bị ghim: `git worktree remove`, `rm -rf`, `Remove-Item` đều fail dù thư mục trống; chính con đường này cũng chặn `npm install -g` trên cùng cây.

- `startTreeWatch` ghi danh toàn bộ cây tiến trình của agent **trong lúc task chạy** (chụp bảng tiến trình bằng `Get-CimInstance Win32_Process`, nhịp 500→10000 ms). Bắt buộc phải chụp trong lúc chạy vì mắt xích shell trung gian chết trước agent, và `ParentProcessId` của Windows chỉ là một con số: query "con của agent" lúc exit không còn thấy nhánh dưới shell đó.
- `reapOwnedTree` lúc agent đã thoát dùng bảng tiến trình mới nhất + bản ghi để giết **gốc** của từng nhánh còn sống bằng `taskkill /T /F` (`/T` phủ các con phía dưới); POSIX signal process group của child đã thoát (SIGTERM, tối đa `TERMINATION_GRACE_MS` rồi SIGKILL). Kết quả là `{checked, reaped, skipped[{pid,name,guard}], tracked}` trong field `cleanup` của task.
- Guard: PID hợp lệ, không phải pid của agent đã thoát, không phải chính bridge, không nằm trong denylist ảnh hệ thống (`reapGuard`), creation time nằm trong cửa sổ task (slack 5s), và PID đã bị tái sử dụng (khác tên hoặc khác thời điểm khởi tạo so với bản ghi) thì **không** giết và cũng không coi là cha hợp lệ.
- Giải phóng chạy **sau** khi trạng thái cuối đã công bố và bị chặn bởi `REAP_BUDGET_MS = 6000`; client không bao giờ chờ nó. `persist` được vá để giữ `request`/`stats` khi ghi bản vá sau này, và retry rename khi `EPERM/EACCES/EBUSY` vì Windows từ chối rename đè lên record mà UI hoặc client đang mở để đọc (đây là bug thật, do test mới lộ ra).
- `removeWorktree` trả `{removed, reason}` với ba lần thử `[0, 200, 600]` ms và không còn nuốt lỗi; chỉ được gọi cho launch chưa kịp spawn. `sweepStaleWorktrees` lúc khởi động xóa **chỉ** thư mục rỗng mang tên task-id, bỏ lại task `queued`/`running`, bỏ lại mọi thư mục còn file và in lý do.
- Bản ghi admin `<toplevel>/.git/worktrees/*` của một worktree do bridge tạo mà thư mục đã mất được xóa lúc khởi động (`pruneWorktrees`). Chỉ bản ghi nằm dưới `.bridge-state/worktrees/`, có thư mục đã mất và không bị khóa; worktree người dùng tạo tay không bị đụng tới.
- Chưa có Windows Job Object: bridge bị giết đột ngột giữa lúc task chạy thì vẫn orphan tree và worktree bị ghim tới khi process giữ nó chết. `agy mcp disable …` (tắt MCP server nguồn gốc vấn đề) là thao tác toàn cục trên cấu hình cá nhân của người dùng nên **không** tự chạy. Chi tiết và việc còn lại: [docs/HANDOFF.md](HANDOFF.md).
