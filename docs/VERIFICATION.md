# Khảo sát và bằng chứng — 2026-10-21

## Bổ sung HTTP độc lập

`npm start` hiện chạy Streamable HTTP tại 127.0.0.1, PORT mặc định 3000; PORT=0 chỉ chọn cổng động khi người dùng yêu cầu. `/mcp` và `/health` đều yêu cầu bearer token. Mẫu client HTTP thay cho command/args ở `config/codex-mcp.windows.toml`, bổ sung `config/claude-mcp.http.json`. Các mục khảo sát CLI bên dưới giữ lại bằng chứng ban đầu; STDIO hiện chỉ là tùy chọn riêng `npm run start:stdio`.

Đã chạy 23/23 unit/integration test: auth, Host/Origin, HTTP body cap, startup giữ sống khi stdin đóng, cổng mặc định bị chiếm, PORT khác, kết nối modern và legacy, mất kết nối lúc task đang chạy, kết nối lại lấy kết quả, và đóng server khi task có child tree. Các test này dùng executable giả và CLI không tồn tại, không gọi AI.

Smoke HTTP AI thật ở `test-results/live-report.json`: SDK client ngắt rồi kết nối lại trong khi agy thật đang chạy, trả đúng BRIDGE_SMOKE_OK, sentinel không đổi, hủy task thật thành công. Script còn kiểm tra SIGINT handler với task đang chạy, server exit và PID con không còn; xem trường shutdown_with_active_task_verified của lần chạy mới nhất. Không dùng test mock để kết luận tích hợp AI hoặc sửa code thành công.

Lần HTTP live cuối ngày khảo sát đạt: endpoint tạm 127.0.0.1:54791, task trả đúng phản hồi trong khoảng 17.2s, reconnected=true, shutdown_with_active_task_verified=true và server_exit_code=0. Endpoint này là cổng thử đã đóng, không phải URL cấu hình sử dụng lâu dài.

Đã khởi động `npm start` thật trong terminal với PORT=0 tại 127.0.0.1:64646, không mở IDE/client để giữ server sống. `npm run check` gọi environment qua HTTP thành công, sau đó gửi Ctrl+C trong terminal: in Shutting down và Stopped. Check lại đúng endpoint đã tắt trả lỗi kết nối kèm hướng dẫn npm start/PORT/token, exit 1. Cổng thử đã đóng; không để lại HTTP server chạy nền. Shutdown có task chạy được xác minh riêng bằng harness SIGINT và agy thật; thao tác Ctrl+C terminal trực tiếp được thử khi không có task.

Chưa sửa cấu hình client thực tế. Tài liệu kết nối đã đối chiếu [Codex HTTP MCP](https://developers.openai.com/codex/mcp/) và [Claude Code MCP](https://code.claude.com/docs/en/mcp), cùng help CLI tại máy. Protocol handshake bằng SDK không chứng minh Codex/Claude Code đã được đăng ký hoặc tải tool.

Chính sách shutdown: ngừng nhận task mới, hủy task đang chạy, dọn process thuộc server rồi đóng HTTP. Disconnect client không kích hoạt shutdown. Task/history sống trong RAM của server, mất khi restart hoặc hết retention. Token và task là phạm vi dùng chung của một người dùng, không có isolation giữa hai client.

## Máy thực tế

- Windows, PowerShell; Node `v24.15.0`, npm `11.12.1`, Codex CLI `0.163.0`.
- `Get-Command agy`: `C:\Users\dotha\AppData\Local\agy\bin\agy.exe`.
- `agy --version`: `1.4.3`.
- `agy --help` có print không tương tác, JSON và stream-json; help của executable được ghi qua stderr, nên probe thu cả hai stream.
- Tài khoản cached dùng được với prompt chỉ phản hồi; không đọc hoặc xuất credential.
- File settings hiện có model nhưng không có permissions.allow tại thời điểm khảo sát. Không sửa file này.

## Các tham số và subcommand được công bố bởi help tại máy

```text
--add-dir --agent -c --continue --conversation --dangerously-skip-permissions
--disable-slash-commands --effort -i --input-format --json-schema --log-file
--mode --model --new-project --output-format -p --print --print-timeout
--project --prompt --prompt-interactive --remote-control --sandbox

agent agents changelog help install mcp mic-serve models plugin plugins
remote-control update
```

Bridge chỉ dùng --version/--help và print/json/print-timeout/disable-slash-commands. Không coi mọi cờ/subcommand trên là đã kiểm thử thực thi. `agy help remote-control` xác nhận start/status/stop của remote-control daemon; đây không phải API submit/status/cancel coding job nên không dùng. `agy models` chạy thành công; bridge không hardcode hay thay model của tài khoản.

## Thử nghiệm thật

1. Chạy bằng `child_process.spawn`, `shell:false`, stdin đóng, stdout/stderr pipe: prompt chỉ phản hồi `BRIDGE_PROBE_OK`, JSON `SUCCESS`, num_turns 1, exit 0, khoảng 11.7 giây tổng.
2. Model cố ý không tồn tại: JSON `ERROR`, stderr có chẩn đoán, exit 1. Xác minh đường lỗi mà không yêu cầu model làm việc.
3. `--print-timeout 1ms`: CLI trả JSON SUCCESS, response rỗng, num_turns 0, exit **0**, stderr báo print timeout. Bridge nhận diện đây là timeout, không thành công.
4. MCP client → server → agy trong scratch workspace, yêu cầu tạo `bridge-smoke.txt`: CLI trả SUCCESS/exit 0 nhưng `denied_actions` chứa `write_file`, response rỗng. Bridge trả failed. Bằng chứng đầy đủ ở `test-results/write-permission-probe.json` (local, gitignored). Chưa chứng minh khả năng chỉnh sửa code qua bridge vì chưa được cấp quyền.
5. Smoke chỉ phản hồi và hủy process thật: `npm run test:live` đạt ngày khảo sát. MCP client nhận `BRIDGE_SMOKE_OK` với completed/exit 0 (khoảng 13.5 giây); sentinel không đổi; task tiếp theo được hủy, status canceled/process_running false. Bằng chứng ở `test-results/live-report.json`. Đọc trường `success`, task.status, response_verified, workspace_unchanged và cancellation.status để biết lần chạy mới nhất.

Unit/integration dùng mock nằm ở `tests/bridge.test.ts`, được tách khỏi script live. Bao gồm validation, boundary/traversal/junction, lock, lifecycle, retention, timeout, cancel cây process và giữ process khác, exit 7, JSON lỗi, partial SUCCESS timeout, permission denial, output cap, redaction, unsupported/spawn failure và protocol stdout sạch.

## Giới hạn đã xác minh và phần chưa xác minh

- Headless hoạt động với cached authentication, prompt không dùng tool. Việc đăng nhập lại vẫn cần tương tác khi session hết hạn.
- Quyền ghi chưa có: cần cấp rule theo workspace sau khi được phê duyệt. Không tự dùng accept-edits, auto hay dangerously-skip-permissions để né bước này.
- Không có CLI job API được xác minh để detach, attach, query hoặc cancel job ID. Task ID do bridge tạo; status/output là dữ liệu bridge thu được. Tác vụ chỉ sống trong tiến trình server.
- Timeout/error có thể bị CLI biểu diễn là SUCCESS/exit 0. Không dùng exit code đơn lẻ để quyết định.
- Không bật stream-json trong triển khai hiện tại: tài liệu mô tả cơ chế nhưng chưa cần kiểm thử để phục vụ print/json. Status chỉ có stdout/stderr đang nhận, không có phần trăm tiến độ. JSON cuối thường chỉ tới khi agent kết thúc.
- --sandbox xuất hiện trong help nhưng chưa xác minh khả năng cách ly Windows cho luồng này, nên không bật hay tuyên bố có OS confinement. Allowlist/preflight không thay thế sandbox.
- Hủy Windows dựa vào taskkill cây của child còn sống. Không bảo đảm xử lý hậu duệ đã detach, PID reuse cực ngắn giữa kiểm tra và taskkill, hoặc server crash. Nếu cần bảo đảm cleanup khi crash, bước tiếp theo là Windows Job Object hoặc worker trong môi trường OS cách ly.
- Lock bảo vệ các process dùng cùng bản cài bridge; không quản lý editor/agent khác hoặc bản cài khác.
- Chưa đăng ký vào cấu hình Codex thật; MCP SDK client handshake thành công không tương đương tool đã có trong phiên Codex hiện tại.

## Đối chiếu nguồn chính thức

- [Antigravity headless](https://antigravity.google/docs/cli/headless/): print một lượt, JSON envelope, stderr chẩn đoán, authentication và permission soft-denial.
- [CLI reference](https://antigravity.google/docs/cli/reference/): tham khảo chung; ưu tiên --help của bản đang cài khi khác biệt.
- [Quyền Antigravity CLI](https://antigravity.google/docs/permissions?tab=cli): cú pháp action(target), file settings và normalization đường dẫn Windows.
- [Official CLI repository](https://github.com/google-antigravity/antigravity-cli): nguồn Google liên kết tới tài liệu chính thức và mô tả cached authentication.
- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/): SDK chính thức; `npm view @modelcontextprotocol/server version engines --json` tại máy trả 2.3.1, Node >=20. Lockfile và npm ls xác nhận dependency đã cài.
- [Codex MCP](https://developers.openai.com/codex/mcp/): stdio command/args và timeouts. `codex mcp --help`, `codex mcp add --help` xác nhận CLI quản lý cấu hình hiện hành.

Tài liệu headless ghi mặc định print-timeout 5m và workspace write tự cho phép; help 1.4.3 tại máy ghi 0s, và thử ghi thực tế bị từ chối. Bridge luôn truyền timeout rõ ràng và tôn trọng denial thực tế, không giả định theo mô tả chung.
