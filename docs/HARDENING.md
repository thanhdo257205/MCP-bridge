# Hardening — nhánh improvements/hardening

11 hạng mục được triển khai thành 11 commit riêng; không thêm dependency, vẫn Node >=20. Không push, tạo PR hay publish npm. `npm run test:live` không được chạy.

## Thay đổi hành vi cần biết

1. Workspace bỏ qua **nội dung** `node_modules` và `.git` khi quét. Link ngoài hai vùng này chỉ được chấp nhận nếu realpath nằm trong workspace; link hỏng bị từ chối. Link/junction trong đường dẫn input vẫn bị từ chối. Đây là preflight, không phải OS sandbox; vùng bỏ qua và thay link sau preflight vẫn là giới hạn.
2. Task queued được validate lại trước launch. Chuyển sang running được ghi trước spawn để restore không kết luận sai rằng task chưa từng sửa file. Recheck trạng thái ngay trước spawn ngăn launch tiếp sau cancel/shutdown trong lúc chờ I/O.
3. POSIX SIGTERM cả nhóm, tối đa 8 giây rồi SIGKILL. Windows vẫn taskkill theo PID/cây thuộc server. Bridge watchdog chạy sau CLI timeout thêm 10 giây; cancellation có thể chờ thêm thời gian cleanup.
4. Startup và acquisition tự thu hồi lock chỉ khi cả hai PID trong owner đều hợp lệ và không còn sống. Record thiếu/hỏng, PID còn sống, ownership đổi hoặc owner cũ hơn lock thì giữ nguyên. `agy-mcp-bridge unlock` dùng cùng logic và không kill process. PID reuse và server crash vẫn cần xử lý thận trọng; chưa có Windows Job Object.
5. Family 1.4.x phải có đủ cờ bắt buộc trong help. Patch khác 1.4.3 có cảnh báo log/environment vì chưa thực thi AI thật; minor/major khác không chạy.
6. Môi trường child mặc định chỉ có PATH, HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP, TMP, TMPDIR, SystemRoot, ComSpec, LANG, LC_*, XDG_*, HTTP_PROXY, HTTPS_PROXY, NO_PROXY; tên không phân biệt hoa thường. Tên chứa TOKEN/SECRET/PASSWORD/API_KEY chỉ được truyền khi có trong `extra_env_passthrough`. Các thiết lập auth/tool phụ thuộc env khác có thể cần opt-in. Không liệt kê token điều khiển bridge.
7. Token Windows mới được harden bằng whoami SID và icacls qua execFile, không shell. Nếu lệnh lỗi, server cảnh báo và vẫn chạy như yêu cầu; chủ máy phải bảo vệ file thủ công. Token cũ không tự đổi ACL. POSIX giữ mode 0600.
8. Prompt mặc định dùng stdin NDJSON, một event user rồi end; stdout phải có đúng một event result hợp lệ. Có fallback argv. Cap API 24000 ký tự và output cap không thay đổi; progress/init cũng tính vào output.
9. Output được gom vào mảng chunk; decode/redact snapshot tối đa mỗi giây, cuối task flush đầy đủ. Byte counts và truncated giữ ngữ nghĩa cũ.
10. Repeated SIGINT/SIGTERM không bỏ cleanup; in thông báo chờ.
11. Prompt nhận clientLabel thực tế; MCP/UI version đọc manifest. Prerelease được so từng phần, numeric so bằng BigInt, ví dụ rc.2 < rc.10; build metadata không ảnh hưởng precedence.

Ví dụ các key mới trong config (merge với config hiện có, không thay toàn bộ file):

```json
{
  "extra_env_passthrough": ["GOOGLE_APPLICATION_CREDENTIALS"],
  "prompt_transport": "stdin"
}
```

Chỉ thêm env khi cơ chế xác thực/tool của chính bạn cần nó. `"prompt_transport": "argv"` quay lại cách gửi prompt cũ và làm nội dung prompt hiện trong command line process. Không tự nới quyền CLI khi gặp permission denial.

## Bằng chứng và giới hạn kiểm thử

- Chạy `npm test` sau từng commit trên Windows và kiểm tra từng snapshot commit trên Ubuntu WSL Node 20 bằng `npm test`. Test POSIX signal được bỏ qua trên Windows và thực thi trên Linux. Test ACL giả lập lỗi/thành công trên cả hai OS; test tạo token trên Windows cũng đi qua ACL thật.
- Test mới bao phủ link nội bộ/ngoài workspace, queue revalidation và history transition, SIGTERM/escalation, PID lock recovery/unlock, patch-version/flag gates, env của executable giả, ACL, stdin/fallback/malformed results, snapshot throttling, repeated signals, client prompt, MCP/UI version và prerelease ordering.
- Một lần suite Windows gặp ECONNRESET trong test HTTP oversized-body có sẵn. Test riêng và suite chạy lại xanh; không nới assertion/body cap/auth để né lỗi.
- `agy --help` xác nhận `--input-format stream-json` đọc NDJSON từ stdin và cần output stream-json. Đối chiếu [tài liệu Google chính thức](https://antigravity.google/docs/cli/headless/) về user/message.content, result envelope và EOF.
- Probe CLI thật dùng **control_request cố ý không hỗ trợ**, không gửi user prompt: exit 2, result ERROR, num_turns 0, tất cả usage counters 0. Xác minh parser/đường lỗi; thành công của AI qua stdin chỉ được test bằng executable giả trong đợt này. Không tuyên bố đã kiểm thử agent thật cho patch khác 1.4.3 hoặc transport mới.
- Không thay bind 127.0.0.1, bearer authentication, Host/Origin hoặc fail-closed khi ownership/capability không rõ. Không mở LAN/HTTP vô danh.
