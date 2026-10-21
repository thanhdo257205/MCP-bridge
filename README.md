# MCP Bridge HTTP: Codex / Claude Code → Antigravity

Server TypeScript chạy độc lập trong terminal, dùng **MCP Streamable HTTP**. Codex và Claude Code kết nối tới cùng endpoint; không khởi chạy process bridge riêng. Không cần mở Antigravity IDE; bridge gọi executable `agy` đã đăng nhập.

`npm start` hiện chạy HTTP. STDIO cũ chỉ còn là chế độ tùy chọn `npm run start:stdio`, không dùng trong các cấu hình client bên dưới. Source bridge ở thư mục phát triển riêng `MCP-bridge`, ngoài repository ứng dụng được giao sửa.

## Quickstart

Requires Git, Node.js ≥20 and a logged-in Antigravity CLI `agy` 1.4.3 on PATH. Works on Windows, Linux and macOS; the longer sections below use PowerShell, the equivalents are:

```bash
git clone https://github.com/thanhdo257205/MCP-bridge.git && cd MCP-bridge
agy --version && npm ci && npm run build
npm start                                   # terminal 1: server on http://127.0.0.1:3000/mcp
export BRIDGE_HTTP_TOKEN="$(cat .bridge-state/http-token)"   # terminal 2, same clone
npm run check                               # calls antigravity_environment
```

Then allow a workspace in `config/workspaces.json` (created empty on first run, git-ignored), register the client ([Codex](#3-kết-nối-codex), [Claude Code](#4-kết-nối-claude-code)) and install the [skill](#9-skill-giao-tiếp-với-antigravity). Bash equivalents of PowerShell snippets: `$env:X = 'v'` → `export X=v`; `Get-Content -Raw f` → `cat f`; `Remove-Item Env:X` → `unset X`.

## 1. Cài đặt và khởi động

Yêu cầu Git, Node.js ≥20, npm và Antigravity CLI **1.4.3** đã đăng nhập, có lệnh `agy` trong PATH. Bản CLI khác bị từ chối đến khi được khảo sát lại. SDK chính thức: server 2.3.1, Node HTTP adapter 2.1.1; lockfile khóa dependency. Các lệnh bên dưới dùng PowerShell trên Windows.

Mở PowerShell tại thư mục bạn muốn lưu source, rồi clone và chạy:

```powershell
git clone https://github.com/thanhdo257205/MCP-bridge.git
Set-Location .\MCP-bridge
agy --version
npm install
npm run build
npm start
```

Nếu đã clone, mở terminal tại thư mục gốc của bản clone (nơi có `package.json`) và bỏ qua hai lệnh clone/chuyển thư mục. Các đường dẫn tương đối trong hướng dẫn được tính từ thư mục này; bạn có thể lưu repo ở bất kỳ vị trí nào.

Mặc định bridge tìm `agy` trong PATH, không phụ thuộc tên tài khoản Windows hay thư mục cài đặt của tác giả. Nếu không tìm thấy, kiểm tra `Get-Command agy`; thêm thư mục cài CLI vào PATH rồi mở terminal mới, hoặc đặt `executable` trong `config/workspaces.json` thành đường dẫn tuyệt đối tới `agy.exe` trên máy của bạn.

`npm ci` có thể thay `npm install` để cài đúng lockfile.

Repo kèm skill **antigravity-bridge** để client giao task và xử lý kết quả theo đúng hợp đồng MCP. Sau build, xem [cách cài skill cho Codex/Claude Code](#9-skill-giao-tiếp-với-antigravity) để cài bằng một lệnh. `npm install` chỉ cài dependency, không tự ghi vào thư mục cấu hình hay skill của client.

Chế độ phát triển:

```powershell
npm run dev
```

`dev` build rồi chạy HTTP với cùng cơ chế bảo mật; hiện không có hot reload. Sau khi sửa source, Ctrl+C rồi chạy `npm run dev` lại. Không tự restart để tránh gián đoạn task đang sửa code.

Server giữ terminal hoạt động tới khi **Ctrl+C**, SIGTERM hoặc lỗi nghiêm trọng. Việc đóng Codex, Claude Code hoặc stdin của bridge không dừng HTTP server. Đóng cưỡng bức cửa sổ terminal không tương đương shutdown an toàn.

Mặc định bind duy nhất `127.0.0.1:3000`. Khi cổng còn trống, terminal in:

```text
[bridge] HTTP server: http://127.0.0.1:3000
[bridge] MCP endpoint: http://127.0.0.1:3000/mcp
[bridge] Health check: http://127.0.0.1:3000/health (bearer authentication required)
```

Cổng bị chiếm: server báo lỗi, thoát mã 1, không tự đổi cổng hoặc địa chỉ bind. Chọn cổng khác:

```powershell
$env:PORT = '3001'
npm start
```

Muốn hệ điều hành chọn một cổng đang trống, đặt `PORT='0'`. Đây là lựa chọn minh bạch do người dùng chỉ định: đọc URL thực tế được in ở terminal rồi cập nhật tất cả client. `PORT` nhận số nguyên 0–65535, không nhận giá trị rỗng. Xóa override để về mặc định: `Remove-Item Env:PORT`.

## 2. Token xác thực và health check

Mọi request tới `/mcp` và `/health` phải có `Authorization: Bearer <token>`. Đây là token dùng chung cho một người dùng cục bộ, không phải OAuth. Không cần `codex mcp login` hay `claude mcp login` cho bridge này.

Nếu chưa đặt `BRIDGE_HTTP_TOKEN`, lần khởi động đầu tự tạo token ngẫu nhiên 256 bit tại `.bridge-state/http-token`, rồi tái sử dụng qua các lần chạy. Server chỉ in **đường dẫn nguồn token**, không in giá trị. Thư mục này được gitignore. Token file dùng mode 0600 trên POSIX; trên Windows phải bảo vệ bằng ACL thư mục tài khoản của bạn, vì mode POSIX không thay thế Windows ACL. Bất cứ ai đọc được token đều có quyền dùng các tool, xem và hủy task của server.

Mở **terminal thứ hai tại thư mục gốc của cùng bản clone** (nơi có `package.json`), rồi đọc token vào môi trường mà không in nó:

```powershell
$env:BRIDGE_HTTP_TOKEN = (Get-Content -Raw '.bridge-state/http-token').Trim()
$headers = @{ Authorization = "Bearer $env:BRIDGE_HTTP_TOKEN" }
Invoke-RestMethod 'http://127.0.0.1:3000/health' -Headers $headers
npm run check
```

`npm run check` không khởi động server hay gọi AI; nó kết nối HTTP và gọi `antigravity_environment`. Nếu không có token trong env, script đọc file token mặc định. Khi server tắt, token sai hoặc URL sai, script thoát mã 1 và hướng dẫn chạy `npm start`, kiểm tra PORT/URL/token, rồi kết nối lại.

Với cổng khác, ví dụ 3001:

```powershell
$env:BRIDGE_MCP_URL = 'http://127.0.0.1:3001/mcp'
npm run check
Invoke-RestMethod 'http://127.0.0.1:3001/health' -Headers $headers
```

`BRIDGE_MCP_URL` dành cho script check; URL của Codex và Claude Code phải cập nhật riêng. Nếu chủ động cấp token bằng env trước `npm start`, dùng token đó ở các client; token env phải dài 32–256 ký tự thuộc A–Z, a–z, 0–9, `_`, `-`. Env ưu tiên hơn file. Không commit token hoặc dán vào prompt. Bridge không chuyển biến `BRIDGE_HTTP_TOKEN` cho child `agy` và lọc giá trị token khỏi output trả về.

## 3. Kết nối Codex

**Các đoạn dưới là thay đổi đề xuất, chưa áp dụng.** Trình bày để chủ máy duyệt trước khi chạy lệnh ghi cấu hình. Mẫu: [config/codex-mcp.windows.toml](config/codex-mcp.windows.toml).

```toml
[mcp_servers.antigravity]
url = 'http://127.0.0.1:3000/mcp'
bearer_token_env_var = 'BRIDGE_HTTP_TOKEN'
startup_timeout_sec = 30
tool_timeout_sec = 60
enabled = true
```

File cấu hình Codex mặc định là `~/.codex/config.toml` (trên Windows: `$env:USERPROFILE\.codex\config.toml`). Nếu bạn đã đặt biến môi trường `CODEX_HOME`, dùng file `config.toml` trong thư mục đó. Nếu đã có mục antigravity kiểu command/args, thay mục đó bằng HTTP sau khi được duyệt, không tạo mục trùng. Không còn command/args nên Codex không spawn bridge.

Sau khi được duyệt có thể dùng CLI thay cho merge TOML (CLI dùng timeout mặc định, thêm timeout bằng TOML nếu cần):

```powershell
codex mcp add antigravity --url 'http://127.0.0.1:3000/mcp' --bearer-token-env-var BRIDGE_HTTP_TOKEN
codex mcp get antigravity
codex mcp list
codex
```

Khởi chạy Codex từ terminal đã nạp token. Với IDE/app đang mở, phải nạp env vào môi trường của app và khởi động lại app; đặt env ở terminal khác không cập nhật tiến trình đã chạy. Trong phiên mới, yêu cầu gọi `antigravity_environment`; phiên bản CLI phải là 1.4.3. `codex mcp list/get` xác nhận cấu hình, không thay thế một tool call thật.

Ngắt kết nối: thoát phiên Codex; server và task vẫn chạy. Muốn bỏ cấu hình, sau khi duyệt chạy `codex mcp remove antigravity`, rồi mở phiên mới. Hoặc đặt `enabled=false` trong block và mở lại phiên. Server chỉ dừng khi bạn Ctrl+C tại terminal server.

Khi đổi cổng, sửa `url`, giữ `bearer_token_env_var`, rồi mở phiên mới. Khi server tắt, Codex báo lỗi kết nối/MCP startup. Không có tiến trình HTTP nào có thể tự trả hướng dẫn khi nó đã tắt; chạy `npm run check` để có chẩn đoán và hướng dẫn cụ thể, sau đó `npm start` ở terminal server và mở lại phiên Codex.

Tham khảo [tài liệu MCP chính thức của Codex](https://developers.openai.com/codex/mcp/).

## 4. Kết nối Claude Code

Mẫu cấu hình đề xuất ở [config/claude-mcp.http.json](config/claude-mcp.http.json), chưa ghi vào cấu hình hiện có:

```json
{
  "mcpServers": {
    "antigravity": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {"Authorization": "Bearer ${BRIDGE_HTTP_TOKEN}"}
    }
  }
}
```

Sau khi duyệt, từ terminal đã nạp token và thư mục project của bạn:

```powershell
claude mcp add --transport http --scope local antigravity 'http://127.0.0.1:3000/mcp' --header 'Authorization: Bearer ${BRIDGE_HTTP_TOKEN}'
claude mcp get antigravity
claude mcp list
claude
```

Dấu nháy đơn PowerShell giữ nguyên `${BRIDGE_HTTP_TOKEN}` trong cấu hình; Claude Code đọc env khi khởi động. Không thay bằng token literal trong lệnh, để tránh lưu token vào history/config. `--scope local` chỉ cấu hình cho project và người dùng hiện tại. Mẫu JSON wrapper dành cho `.mcp.json`; không tự tạo file đó trong repository ứng dụng.

Trong Claude Code dùng `/mcp` để xem trạng thái, reconnect hoặc disable server, và gọi `antigravity_environment` để kiểm tra tool. Nếu server tắt, `/mcp` hiển thị lỗi kết nối; chạy `npm run check`, bật server bằng `npm start`, rồi reconnect qua `/mcp` hoặc mở lại phiên. Thoát Claude Code/disable kết nối không hủy task.

Gỡ sau khi duyệt: `claude mcp remove antigravity --scope local`. Đổi cổng: cập nhật URL trong cùng entry, hoặc remove rồi add lại URL mới với cùng header env, sau đó reconnect. Không cần dừng server vì client ngắt kết nối.

Tham khảo [tài liệu MCP chính thức của Claude Code](https://code.claude.com/docs/en/mcp). Các phiên bản CLI và kết quả đã kiểm chứng được ghi trong [báo cáo khảo sát](docs/VERIFICATION.md). Sau khi cấu hình trên máy của bạn, hãy gọi tool thật từ từng client để kiểm tra kết nối; kiểm thử protocol bằng SDK không thay thế bước này.

## 5. Cho phép workspace và giao task

`config/workspaces.json` là file cục bộ, không nằm trong git; lần chạy đầu tự tạo với `allowed_workspaces: []` (không file nào bị ghi đè). Chỉ thêm đường dẫn tuyệt đối đã được cấp quyền; [mẫu](config/workspaces.example.json). Có thể chọn file JSON khác qua env `ANTIGRAVITY_BRIDGE_CONFIG`; restart server để áp dụng. Đừng giao workspace chứa chính source bridge đang chạy.

Đăng ký client thành công chưa cấp quyền sửa file cho Antigravity. Lần thử thật trước đây bị `write_file` từ chối. Cần phê duyệt rule tối thiểu trong settings Antigravity hoặc cấp quyền qua phiên tương tác, rồi kiểm thử lại. Ví dụ **chưa áp dụng**:

```json
{"permissions":{"allow":["write_file(C:/absolute/path/to/approved-project/)"]}}
```

Merge rule cần thiết vào settings, không thay toàn bộ cấu hình; không dùng wildcard global hay bypass permissions. Test commands phải được cho phép riêng; Codex có thể tự chạy test. Deploy/xóa dữ liệu/thay đổi hệ thống yêu cầu xác nhận tương tác riêng và không thuộc task thông thường. Chi tiết hạn chế CLI ở [docs/VERIFICATION.md](docs/VERIFICATION.md).

Luồng sử dụng trong Codex hoặc Claude Code:

1. Đọc code và Git status trước task; chia task nhỏ, rõ file được sửa và tiêu chí nghiệm thu.
2. Gọi `antigravity_delegate` với arguments mẫu ở dưới.
3. Lưu `task_id`; gọi `antigravity_task_wait` (tối đa 25 giây mỗi lần, trả sớm khi task xong) hoặc `antigravity_task_status`, rồi lấy `antigravity_task_output`.
4. Nếu client bị đóng, bật lại client, gọi environment để xem `recent_tasks`, rồi query task ID cũ. Không giao trùng task khi chưa kiểm tra trạng thái.
5. Tech Lead review diff thực tế, gồm file untracked, chạy test và đánh giá từng tiêu chí. Nếu chưa đạt, giao task sửa tiếp.

```json
{
  "task": "Sửa hàm parseCount trong src/count.ts để từ chối số âm. Chỉ sửa hàm này và test liên quan. Không chạy lệnh; Tech Lead tự test. Báo cáo file đã sửa và vấn đề còn lại.",
  "workspace": "C:/absolute/path/to/approved-project",
  "acceptance_criteria": ["Số âm trả lỗi validation hiện hành", "0 và số nguyên dương giữ hành vi cũ"],
  "timeout_seconds": 300
}
```

| Tool | Công dụng |
|---|---|
| `antigravity_environment` | CLI/version/allowlist/giới hạn và recent_tasks để tìm lại task ID |
| `antigravity_delegate` | Nhận task, workspace, acceptance_criteria, context?, timeout_seconds?; trả running/task_id |
| `antigravity_task_status` | Trạng thái/process/thời gian/lỗi/denied_actions/số byte theo task_id, không kèm log (rẻ để poll) |
| `antigravity_task_wait` | Chờ tối đa `wait_seconds` (1–25, mặc định 20) tới khi task kết thúc, trả cùng nội dung như status; còn chạy thì gọi lại |
| `antigravity_task_output` | Phản hồi cuối, stdout/stderr, lỗi, denied_actions, truncation theo task_id |
| `antigravity_cancel_task` | Hủy cây tiến trình thuộc task; không rollback thay đổi file |

`completed` chỉ là CLI chạy xong và có envelope hợp lệ. Luôn `review_required=true`, `acceptance_verified=false`. SUCCESS/exit 0 vẫn có thể bị bridge đánh dấu failed do permission denial hoặc timeout. Prompt mẫu review/sửa tiếp: [docs/PROMPTS.md](docs/PROMPTS.md).

### Khi chỉ muốn Codex/Claude tự làm

- **Công tắc cứng (khuyến nghị):** `npm run delegation -- off` chặn mọi lần giao task mới ngay lập tức, không cần restart hay token. `npm run delegation -- on` bật lại, `-- status` xem trạng thái. Có thể đặt `BRIDGE_DELEGATION=off` trước `npm start` (giá trị khác `on`/`off` cũng bị coi là tắt). Khi tắt, `antigravity_delegate` trả lỗi nêu rõ "disabled by the bridge owner" và `antigravity_environment` trả `delegation: {enabled: false, reason}`. Task đang chạy không bị dừng và vẫn xem/hủy được.
- **Chỉ dẫn cho agent:** skill có mục "When NOT to delegate": agent không giao việc khi bạn bảo tự làm, khi bạn không nhắc Antigravity, hoặc khi công tắc đang tắt. Đây là chỉ dẫn, không phải rào chắn; muốn chắc chắn hãy dùng công tắc. Chạy lại `npm run skill:install` sau khi pull để cập nhật skill.
- Muốn tắt theo từng client: `enabled=false` trong cấu hình Codex hoặc `/mcp` trong Claude Code (xem mục 3, 4).

## 6. Vòng đời, giới hạn và dừng an toàn

TaskManager thuộc HTTP server, không thuộc phiên MCP. Server sử dụng handler stateless cho kết nối MCP; mọi request truy cập cùng TaskManager. Disconnect, DELETE session, request cancellation hoặc client thoát không tự hủy task đã tiếp nhận. Nếu mất response giao task, tra `recent_tasks` trước khi thử lại. Một người dùng có cùng token được xem/hủy task từ cả hai client.

Mặc định giữ 50 task (tối đa cấu hình 200); task cũ hoàn tất bị loại bỏ. Bản ghi task được lưu tại `.bridge-state/tasks/<task_id>.json` (mode 0600 trên POSIX; nội dung đã qua lọc secret) và nạp lại khi khởi động, nên tra được kết quả sau restart. Task đang chạy lúc server dừng đột ngột được nạp lại với trạng thái `failed` ("Bridge restarted…"): tiến trình `agy` không được khôi phục, hãy kiểm tra diff dở dang. Đây là lịch sử kết quả, không phải durable task recovery. Task vẫn timeout nếu không có client theo dõi. Chỉ một task chạy toàn cục, khóa giữa các process dùng cùng bản cài tại `.bridge-state/execution.lock`; không điều phối editor/agent ngoài hoặc bản cài bridge khác.

Nhấn **Ctrl+C một lần** tại terminal server:

1. Ngừng lắng nghe kết nối và không nhận task mới.
2. Hủy ngay các task đang chạy, dọn cây process do server khởi tạo; không đợi task tự hoàn thành.
3. Đóng MCP handler, cho kết nối đang có tối đa 3 giây để drain sau khi cleanup; sau đó đóng cưỡng bức socket còn lại.
4. In `[bridge] Stopped` khi thành công. Không rollback file đã sửa. Xem diff trước lần chạy tiếp theo.

Nếu cleanup thất bại, báo lỗi và giữ execution lock khi process chưa đóng. Khi gặp lỗi lock, thông báo cho biết PID server chủ lock còn chạy hay không; nếu PID đã chết, lock có thể cũ — xác nhận không còn tiến trình `agy` rồi tự xóa thư mục lock được nêu trong thông báo. Bridge không tự xóa lock hoặc kill process Antigravity khác. Force kill server/đóng terminal/OS crash không bảo đảm cleanup: chưa có Windows Job Object. Sau crash, kiểm tra process và `.bridge-state/owner.json` trước khi xử lý lock; PID cũ có thể đã tái sử dụng.

Giới hạn mặc định: task 300s, tối đa 900s; output mỗi stream 256 KiB (cấu hình 1 KiB–1 MiB), vượt trần sẽ hủy task và trả failed/truncated. Tổng task JSON tối đa 24000 ký tự cho command line Windows; HTTP body tối đa 128 KiB. Status không cung cấp phần trăm tiến độ; JSON cuối thường chỉ tới khi agy kết thúc. Không dùng CLI detach/remote-control API chưa được xác minh.

## 7. Bảo mật và vận hành

Chỉ listen `127.0.0.1`, không có tùy chọn bind LAN trong bản này. Host phải đúng địa chỉ/cổng thực tế; Origin khác bị từ chối; không bật CORS cho website ngoài. Mọi endpoint yêu cầu bearer token, so sánh constant time khi cùng độ dài. Không log HTTP headers/body hoặc token. Không mở HTTP không xác thực.

Allowlist kiểm tra realpath, boundary, traversal và symlink/junction trong cây (trần 200000 entries). **Đây không phải OS sandbox**: không ngăn tiến trình khác thay link sau preflight, không kiểm soát đầy đủ hành động agent từ settings/hooks/MCP hiện có. Token file và credentials ngoài workspace vẫn cần quyền OS phù hợp. Lọc output nhận diện secret đã biết và mẫu phổ biến, không nhận ra mọi bí mật. Không đưa secret vào task.

Để truy cập từ máy khác, cần thiết kế riêng TLS, xác thực/authorization và cách ly workspace. Bản này không triển khai remote/LAN; không đổi bind sang 0.0.0.0 hoặc mở firewall để né lỗi cổng.

Các lỗi thường gặp:

- `Port is already in use`: chọn PORT khác, cập nhật URL cả hai client.
- 401: token thiếu/sai; nạp lại env rồi khởi động lại client. Không thử OAuth login với bridge này.
- 403: sai Host/Origin; dùng đúng URL 127.0.0.1 được in ra, không đi qua proxy/alias.
- Connection refused/fetch failed: server tắt hoặc sai cổng; chạy check, bật lại server và reconnect.
- CLI unsupported: kiểm tra agy path/version/help; environment vẫn có thể hoạt động dù không giao được task.
- `denied_actions`: Antigravity chưa cho phép thao tác; xin quyền tối thiểu, không bỏ permission check.
- Workspace bị từ chối: kiểm tra allowlist, link/junction hoặc số entry vượt trần.
- Timeout/canceled/output limit: có thể có diff dở dang; review trước khi giao task tiếp theo.

## 8. Kiểm thử và cấu trúc source

```powershell
npm test
npm run test:live
```

`npm test` (cũng chạy trong [CI](.github/workflows/ci.yml) trên Ubuntu và Windows, Node 20/22): unit/integration dùng executable giả, không gọi AI. Bao gồm lifecycle/security cũ và HTTP startup/port conflict/PORT tùy chọn/auth/Host/Origin/body limit/kết nối hai protocol era/client reconnect/task completion/cancel/server shutdown.

`test:live`: **gọi AI thật**, dùng cached login/quota. Test harness khởi động HTTP server riêng với PORT=0 và scratch workspace, dùng official SDK HTTP client, ngắt/kết nối lại khi task chạy, xác minh `BRIDGE_SMOKE_OK` và sentinel không đổi, hủy task thật, rồi kiểm tra shutdown có task đang chạy. Trên Windows, harness phát event SIGINT vào đúng handler của entry point qua IPC riêng của harness; kiểm tra Ctrl+C terminal được ghi riêng trong báo cáo. Đây không phải yêu cầu client production tự khởi động server. Kết quả ở `test-results/live-report.json`; phần sửa file thật vẫn bị chặn đến khi cấp quyền.

`src/index.ts`: HTTP entry; `src/http.ts`: listener/auth/routing/shutdown; `src/runtime.ts`: CLI và TaskManager dùng chung; `src/tools`: tool; `src/antigravity`: child process; `src/security`: validation/workspace/token/redaction; `src/tasks`: lifecycle/lock/output; `scripts/check.ts`: kiểm tra server đang chạy; `scripts/live.ts`: AI smoke test. Không thay cấu hình Codex/Claude Code/Antigravity trong test.

## 9. Skill giao tiếp với Antigravity

Skill [antigravity-bridge](skills/antigravity-bridge/SKILL.md) hướng dẫn client dùng 6 tool theo schema thật, ghi task ID, xử lý disconnect/reconnect, timeout, permission denial, output bị cắt và review diff. Skill dùng chung chuẩn `SKILL.md` cho Codex và Claude Code. Đây là hướng dẫn cho Tech Lead, không cài vào Antigravity; prompt Developer đã được bridge gửi kèm mỗi task.

Sau `npm install` và `npm run build`, chạy từ thư mục clone:

```powershell
# Chọn client bạn sử dụng; không cần chạy cả ba lệnh.
npm run skill:install -- --client codex
npm run skill:install -- --client claude
npm run skill:install -- --client both
```

Đích mặc định cho người dùng hiện tại, không chứa đường dẫn riêng của tác giả:

| Client | File được cài |
|---|---|
| Codex | `~/.agents/skills/antigravity-bridge/SKILL.md` |
| Claude Code | `~/.claude/skills/antigravity-bridge/SKILL.md` |

`~` là thư mục tài khoản hệ điều hành đang chạy lệnh. Cài cho riêng một project bằng `--project` là đường dẫn tuyệt đối tới project đã có; cài đặt sẽ tạo `.agents/skills/antigravity-bridge` và/hoặc `.claude/skills/antigravity-bridge` bên trong project đó. Ví dụ PowerShell, thay đường dẫn mẫu bằng project thật:

```powershell
npm run skill:install -- --client both --project 'C:\path\to\your-project'
```

Installer chỉ ghi `SKILL.md`, không sửa config MCP, allowlist, token, AGENTS.md/CLAUDE.md hay settings Antigravity. Nội dung giống nhau thì không ghi lại; nếu skill cùng tên đã khác nội dung, lệnh báo lỗi để bạn review/merge thủ công, không tự ghi đè hoặc xóa. Sau khi `git pull` và build bản mới, chạy lại installer để kiểm tra cập nhật; xử lý bản tùy chỉnh thủ công nếu lệnh báo khác biệt. Có thể copy thư mục skill vào đường dẫn discovery do client/môi trường của bạn hỗ trợ nếu không dùng vị trí mặc định.

Mở lại client nếu skill chưa xuất hiện. Codex có thể chọn qua `/skills` hoặc gọi trong prompt:

```text
$antigravity-bridge Phân tích lỗi parseCount, giao task sửa có tiêu chí nghiệm thu
cho Antigravity trong workspace đã cấp quyền, rồi review diff và chạy test.
```

Trong Claude Code:

```text
/antigravity-bridge Phân tích lỗi parseCount, giao task sửa có tiêu chí nghiệm thu
cho Antigravity trong workspace đã cấp quyền, rồi review diff và chạy test.
```

Skill có thể được client tự chọn khi yêu cầu phù hợp. Cài skill không tự kết nối HTTP server hoặc đăng ký MCP tools; cần hoàn thành phần cấu hình client và workspace trước. Skill không thể bảo đảm không có lỗi CLI/model/mạng, không mở thêm quyền và không thay thế kiểm tra diff/test. Kết nối bị mất không phải lý do tự giao lại task; skill yêu cầu tìm task cũ trước để tránh chạy trùng.

Vị trí và cách gọi đã đối chiếu [Codex skills](https://developers.openai.com/codex/skills/) và [Claude Code skills](https://code.claude.com/docs/en/skills). Validator kiểm tra cấu trúc skill; test installer dùng thư mục tạm, không gọi AI hay cài vào skill cá nhân. Chưa đánh giá chất lượng quyết định của agent bằng behavioral eval chỉ từ các test này.

## 10. Giao diện web

Khi `npm start` đang chạy, mở `http://127.0.0.1:3000/ui` (đúng cổng đã in ở terminal) trên cùng máy. Giao diện chỉ chạy trong server của bridge, **không đi qua Codex/Claude nên không tốn thêm token của chúng**, và không thêm tool MCP nào.

Đăng nhập bằng bridge token, dán vào ô nhập (`Get-Content .bridge-state/http-token` hoặc `cat .bridge-state/http-token`). Server đổi token lấy một mã phiên ngẫu nhiên, hết hạn sau 8 giờ hoặc khi restart, gửi qua header chứ không dùng cookie; token không bao giờ được hiển thị lại. Sai quá 10 lần trong một phút thì bị khóa tạm.

| Màn hình | Nội dung |
|---|---|
| Task | Tổng quan (trạng thái bridge, phiên bản `agy`, công tắc giao việc, số task đang chạy); danh sách task; với mỗi task là cuộc trao đổi **Tech Lead → Antigravity** (yêu cầu, tiêu chí nghiệm thu, ngữ cảnh) và **Antigravity → Tech Lead** (phản hồi cuối, thao tác bị từ chối quyền, lỗi), log stdout/stderr, prompt đầy đủ gửi tới `agy`. Tự cập nhật; nút Hủy task cho task đang chạy |
| Cài đặt | Công tắc giao việc cho Antigravity (cùng cơ chế với `npm run delegation`, bị khóa nếu đặt `BRIDGE_DELEGATION`), endpoint MCP, thông tin CLI, workspace được phép, giới hạn, lưu ý. Workspace và giới hạn chỉ đọc: sửa trong `config/workspaces.json` rồi khởi động lại |

Lưu ý bảo mật: nội dung yêu cầu và phản hồi được hiển thị dạng văn bản thuần, trang dùng CSP không cho script/style nội tuyến hay tải từ nơi khác, nên output của model không thể thực thi. Yêu cầu của Tech Lead được lưu cùng bản ghi task trong `.bridge-state/tasks` (đã qua lọc secret nhận diện được) để xem lại sau khi restart; đừng đưa secret vào task. Giao diện chỉ đọc, ngoại trừ hai thao tác cần phiên đăng nhập: hủy task và bật/tắt giao việc. Mã nguồn giao diện nằm ở `ui/` (HTML/CSS/JS thuần, không cần build), phần máy chủ ở `src/ui/`.
