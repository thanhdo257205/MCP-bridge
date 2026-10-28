# Khảo sát và bằng chứng — 2026-10-21

## Bổ sung HTTP độc lập

Bổ sung skill `skills/antigravity-bridge/SKILL.md` và installer chủ động `npm run skill:install`. Tổng 26/26 test đạt sau bổ sung; 3 test mới xác minh cài đúng nội dung, cài lặp không đổi, không ghi đè tùy chỉnh, scope user/project và CLI chạy từ thư mục khác. Test dùng thư mục tạm, không cài vào profile thật. Skill đã qua `quick_validate.py`; đây là kiểm tra cấu trúc và installer, không phải behavioral eval hay cam kết agent luôn tuân thủ hướng dẫn.

`npm start` hiện chạy Streamable HTTP tại 127.0.0.1, PORT mặc định 3000; PORT=0 chỉ chọn cổng động khi người dùng yêu cầu. `/mcp` và `/health` không yêu cầu xác thực (chỉ loopback; Host/Origin vẫn bị kiểm tra). Mẫu client HTTP thay cho command/args ở `config/codex-mcp.windows.toml`, bổ sung `config/claude-mcp.http.json`. Các mục khảo sát CLI bên dưới giữ lại bằng chứng ban đầu; STDIO hiện chỉ là tùy chọn riêng `npm run start:stdio`.

Đã chạy 23/23 unit/integration test: Host/Origin, HTTP body cap, startup giữ sống khi stdin đóng, cổng mặc định bị chiếm, PORT khác, kết nối modern và legacy, mất kết nối lúc task đang chạy, kết nối lại lấy kết quả, và đóng server khi task có child tree. Các test này dùng executable giả và CLI không tồn tại, không gọi AI.

Smoke HTTP AI thật ở `test-results/live-report.json`: SDK client ngắt rồi kết nối lại trong khi agy thật đang chạy, trả đúng BRIDGE_SMOKE_OK, sentinel không đổi, hủy task thật thành công. Script còn kiểm tra SIGINT handler với task đang chạy, server exit và PID con không còn; xem trường shutdown_with_active_task_verified của lần chạy mới nhất. Không dùng test mock để kết luận tích hợp AI hoặc sửa code thành công.

Lần HTTP live cuối ngày khảo sát đạt: endpoint tạm 127.0.0.1:54791, task trả đúng phản hồi trong khoảng 17.2s, reconnected=true, shutdown_with_active_task_verified=true và server_exit_code=0. Endpoint này là cổng thử đã đóng, không phải URL cấu hình sử dụng lâu dài.

**Cập nhật 2026-10-26:** chạy lại `npm run test:live` với `agy 1.4.7` trên cùng máy, đạt đầy đủ: task trả đúng `BRIDGE_SMOKE_OK`, `response_verified=true`, `workspace_unchanged=true`, hủy task thật `canceled`, `shutdown_with_active_task_verified=true`, `server_exit_code=0`. Vì vậy 1.4.7 được thêm vào danh sách patch đã xác minh; các số liệu 1.4.3 phía trên giữ nguyên làm bằng chứng lịch sử.

**Cập nhật 2026-10-28 — `agy 1.4.8` và `agy 1.4.9`.** Hai patch này vào `VERIFIED_AGY_VERSIONS` vì mỗi patch có một lần `npm run test:live` đạt trên CLI thật, không phải vì một task lẻ chạy được:

- **1.4.8** — đợt nghiệm thu nhánh `antigravity` (bằng chứng ghi ở `docs/HANDOFF.md` mục 6.3): exit 0, `success: true`, `workspace_unchanged: true`, `reconnected: true`, `shutdown_with_active_task_verified: true`, smoke `completed` trả đúng `BRIDGE_SMOKE_OK`, mission ba bước `a → b → c` cả ba `completed`, sáu lời từ chối vẫn nguyên văn, task cancel `canceled` exit 1, `denied_actions: []`.
- **1.4.9** — ngày 2026-10-28, `node dist/scripts/live.js` trên `main` `17209c3` (trước bản sửa này, nên đường cài đặt vẫn báo `ready 1.4.9` kèm cảnh báo "only 1.4.3 and 1.4.7 have been verified"): **exit 0**, `success: true`, `started_at 08:59:49Z → finished_at 09:00:59Z` (70,7 s cho sáu task thật, một trong số đó bị hủy ngay), smoke `completed` exit 0 `BRIDGE_SMOKE_OK`, `response_verified=true`, `workspace_unchanged=true` (sentinel `UNCHANGED`, thư mục chỉ còn `sentinel.txt`), `reconnected=true`, mission `a/b/c` đều `completed` với `progress {total:3, completed:3, active:0, ready:0, pending:0, unmet:0}` và `plan_steps:3`, cancel `canceled` exit 1 `process_running=false` `denied_actions: []`, `server_exit_code=0`, `shutdown_with_active_task_verified=true` (PID 33664 đã chết khi server tắt).

Sau bản sửa, `antigravity_environment` trên đúng CLI 1.4.9 không còn cảnh báo patch chưa xác minh, và `limitations` đọc là "real execution was verified on 1.4.3, 1.4.7, 1.4.8 and 1.4.9".

Đã khởi động `npm start` thật trong terminal với PORT=0 tại 127.0.0.1:64646, không mở IDE/client để giữ server sống. `npm run check` gọi environment qua HTTP thành công, sau đó gửi Ctrl+C trong terminal: in Shutting down và Stopped. Check lại đúng endpoint đã tắt trả lỗi kết nối kèm hướng dẫn npm start/PORT, exit 1. Cổng thử đã đóng; không để lại HTTP server chạy nền. Shutdown có task chạy được xác minh riêng bằng harness SIGINT và agy thật; thao tác Ctrl+C terminal trực tiếp được thử khi không có task.

Chưa sửa cấu hình client thực tế. Tài liệu kết nối đã đối chiếu [Codex HTTP MCP](https://developers.openai.com/codex/mcp/) và [Claude Code MCP](https://code.claude.com/docs/en/mcp), cùng help CLI tại máy. Protocol handshake bằng SDK không chứng minh Codex/Claude Code đã được đăng ký hoặc tải tool.

Chính sách shutdown: ngừng nhận task mới, hủy task đang chạy, dọn process thuộc server rồi đóng HTTP. Disconnect client không kích hoạt shutdown. Task/history sống trong RAM của server, mất khi restart hoặc hết retention. Task là phạm vi dùng chung của mọi client kết nối tới bridge, không có isolation giữa hai client.

## Máy thực tế

- Windows, PowerShell; Node `v24.15.0`, npm `11.12.1`, Codex CLI `0.163.0`.
- `Get-Command agy`: `%LOCALAPPDATA%\agy\bin\agy.exe` (đường dẫn ứng dụng của user đang chạy lệnh, không phải đường dẫn cố định).
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
6. Dọn cây tiến trình và sweep worktree (2026-10-26, `agy` 1.4.7, scratch trong `%TEMP%`, repo git giả): bridge khởi động với một thư mục worktree rỗng còn sót và một thư mục còn file → log báo xóa đúng cái rỗng, giữ đúng cái có file. Task worktree thật trả `completed`, `scope.checked=true`, `changed=1`, `out_of_scope=[]`, `cleanup={checked:true, reaped:[30768,24304], skipped:[], tracked:14}` và log `[bridge] Task tree release: 2 process tree(s) reaped, 0 left running`. Probe đọc cwd của mọi process (PEB) trả `HITS 0`, `rm -rf` toàn bộ scratch thành công không cần force, `note.txt` trong worktree là `REAP_OK`, workspace gốc chỉ còn `[.git, a.txt]`, shutdown confirm trả 202 và server exit 0. Lần chạy **trước** bản sửa cho `HITS 3` với đúng chuỗi `agy → cmd (chết) → npx open-figma-mcp → cmd → node`, `cleanup.reaped` chỉ có 1 PID — đó là bằng chứng vì sao phải ghi cây tiến trình trong lúc task chạy. Bằng chứng: `test-results/reap-report.json` (gitignored), cách chạy lại ở `docs/HANDOFF.md`.

7. Chạy lại đúng kịch bản trên với bản đã bịt lỗ hổng đợt 2 (2026-10-27, `agy` 1.4.7, scratch `%TEMP%`): task worktree `completed`, `scope={checked:true, changed:1, out_of_scope:[], truncated:false}`, `cleanup={checked:true, reaped:[28256,29124,23416], skipped:[], tracked:15}`, log `3 process tree(s) reaped, 0 left running`, probe cwd `HITS 0`, `note.txt` = `REAP_OK`, workspace gốc `[.git, a.txt]`, home + repo scratch xóa sạch, shutdown 202 và exit 0. `skipped` rỗng nghĩa là phép đọc-lại-pid trước khi giết không đổi quyết định trên đường thường; `tracked: 15` so với 3 gốc bị giết xác nhận phần ghi cây lúc chạy vẫn đang làm việc. Một bridge **riêng** (script `ui-cleanup-check.mjs`, task `2f8a65f8`, `cleanup={reaped:[35600,19716], tracked:10}`) được mở bằng Chrome DevTools thật: trang chi tiết task hiển thị đúng dòng `Tiến trình agent để lại: đã giải phóng 2 cây tiến trình (35600, 19716) · đã ghi danh 10 tiến trình trong lúc agent chạy`, nằm dưới dòng scope và không phải kiểu cảnh báo vì `skipped` rỗng; shutdown lịch sự trả 202, pid biến mất, scratch xóa được ngay. Unit: Windows `npm test` **220 test / 214 pass / 0 fail / 6 skipped** (234,1 s) và Linux (WSL, Node 20.20.2) **220 / 219 / 0 fail / 1 skipped** (195,0 s) — Linux là nền để sáu test nhóm POSIX signal chạy thật, trong đó vòng `SIGTERM → 8 s → SIGKILL` với survivor thật chưa từng chạy trước đây. Mỗi fix kèm một phép thử ngược: tháo `verify` → test pid-cấp-lại đỏ; tháo `Promise.race` trong `shutdown()` → test verdict-khi-tắt đỏ; tháo nhịp cuối của `stop()` → test watch đỏ.

Unit/integration dùng mock nằm ở `tests/bridge.test.ts`, được tách khỏi script live. Bao gồm validation, boundary/traversal/junction, lock, lifecycle, retention, timeout, cancel cây process và giữ process khác, exit 7, JSON lỗi, partial SUCCESS timeout, permission denial, output cap, redaction, unsupported/spawn failure và protocol stdout sạch.

## Giới hạn đã xác minh và phần chưa xác minh

- Headless hoạt động với cached authentication, prompt không dùng tool. Việc đăng nhập lại vẫn cần tương tác khi session hết hạn.
- Quyền ghi chưa có: cần cấp rule theo workspace sau khi được phê duyệt. Không tự dùng accept-edits, auto hay dangerously-skip-permissions để né bước này.
- Không có CLI job API được xác minh để detach, attach, query hoặc cancel job ID. Task ID do bridge tạo; status/output là dữ liệu bridge thu được. Tác vụ chỉ sống trong tiến trình server.
- Timeout/error có thể bị CLI biểu diễn là SUCCESS/exit 0. Không dùng exit code đơn lẻ để quyết định.
- Không bật stream-json trong triển khai hiện tại: tài liệu mô tả cơ chế nhưng chưa cần kiểm thử để phục vụ print/json. Status chỉ có stdout/stderr đang nhận, không có phần trăm tiến độ. JSON cuối thường chỉ tới khi agent kết thúc.
- --sandbox xuất hiện trong help nhưng chưa xác minh khả năng cách ly Windows cho luồng này, nên không bật hay tuyên bố có OS confinement. Allowlist/preflight không thay thế sandbox.
- Hủy Windows vẫn dựa vào taskkill cây của child còn sống; khi child tự thoát, bridge giải phóng các nhánh đã được ghi danh trong lúc chạy (mục 6 ở trên). Không bảo đảm: process sinh ra **và** mất cha giữa hai nhịp poll, PID reuse trong cửa sổ rất ngắn giữa bảng tiến trình và `taskkill`, hay server bị giết đột ngột/crash — ba trường hợp này vẫn để lại tree ghim thư mục. Nếu cần bảo đảm cleanup kể cả khi crash, bước tiếp theo là Windows Job Object (`KILL_ON_JOB_CLOSE`) hoặc worker trong môi trường OS cách ly; chưa làm.
- Nguồn gốc tiến trình giữ cwd nằm ở MCP server mà `agy` tự khởi động (`open-figma-mcp`, `chrome-devtools-mcp`) theo cấu hình **toàn cục** `~/.gemini/config/mcp_config.json`. Bridge dọn sau khi agent thoát, không ngăn chúng khởi động; tắt chúng là thay đổi cấu hình cá nhân của người dùng nên chưa tự làm.
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
