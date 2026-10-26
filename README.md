# MCP Bridge HTTP: agent điều phối → Antigravity / Codex

Server TypeScript chạy độc lập trong terminal, dùng **MCP Streamable HTTP**. Codex, Claude Code hoặc agent điều phối khác kết nối tới cùng endpoint; không khởi chạy process bridge riêng. Bridge gọi CLI agent đã đăng nhập: `agy` (Antigravity) và/hoặc `codex exec` (Codex). Mỗi task chọn agent, chế độ cách ly và quyền tự duyệt; task worktree chạy song song trong git worktree riêng.

`npm start` hiện chạy HTTP. STDIO cũ chỉ còn là chế độ tùy chọn `npm run start:stdio`, không dùng trong các cấu hình client bên dưới. Source bridge ở thư mục phát triển riêng `MCP-bridge`, ngoài repository ứng dụng được giao sửa. Kế hoạch nhiều agent và trạng thái từng phase ở [docs/MULTI-AGENT-PLAN.md](docs/MULTI-AGENT-PLAN.md).

## Cài từ npm (người dùng)

```bash
npm install -g agy-mcp-bridge        # cần Node.js >= 20; Antigravity CLI `agy` 1.4.x và/hoặc Codex CLI là tùy chọn
agy-mcp-bridge workspaces add /duong/dan/toi/project   # cấp quyền cho một thư mục (khởi động lại server sau khi đổi)
agy-mcp-bridge                       # mở server http://127.0.0.1:3000 ; giao diện web ở /ui
```

Bridge tự dò `agy` và `codex` khi khởi động; agent nào không có thì bị đánh dấu unavailable và không nhận task. Chọn thứ tự ưu tiên và bật/tắt từng agent trong `agents` của `config/workspaces.json`.

**Cách nhanh nhất:** mở terminal tại thư mục dự án rồi chạy `agy-mcp-bridge --workspace .` (cho phép thư mục hiện tại **chỉ trong lần chạy này**, không lưu vào cấu hình; có thể lặp lại cờ cho nhiều thư mục, và log in ra từng thư mục đã được cho phép; thư mục sai hoặc là chính thư mục cài bridge thì dừng ngay, không khởi động server). Muốn lưu lâu dài thì dùng `agy-mcp-bridge workspaces add .`. Trong giao diện web, mục Cài đặt đánh dấu "chỉ lần chạy này" bên cạnh các thư mục này.

Các lệnh khác: `agy-mcp-bridge check | setup codex|claude|both | delegation on|off|status | skill install --client codex|claude|both | config | update | help`. Thêm `--open` để tự mở giao diện web trong trình duyệt mặc định khi server đã chạy (`agy-mcp-bridge --open`). Cấu hình và lịch sử task nằm trong thư mục dữ liệu của người dùng (Linux `~/.config/agy-mcp-bridge`, macOS `~/Library/Application Support/agy-mcp-bridge`, Windows `%APPDATA%\agy-mcp-bridge`), không nằm trong thư mục cài đặt nên không mất khi cập nhật; đổi chỗ bằng `BRIDGE_HOME`. `agy-mcp-bridge config` in ra các đường dẫn thật. Phần dưới đây dùng `npm start`/`npm run ...` cho bản clone từ git; với bản cài từ npm hãy dùng lệnh `agy-mcp-bridge` tương ứng.

**Skill cho Codex / Claude Code:** gói npm chứa file skill nhưng `npm install` không tự ghi vào thư mục cấu hình của client. Thay vào đó, lần đầu bạn chạy `agy-mcp-bridge` trong terminal tương tác, bridge hiện đường dẫn sẽ ghi rồi hỏi `Install it now? [codex / claude / both / N]`. Chọn mới cài (chỉ cho client chưa có skill; skill bạn đã tự sửa không bao giờ bị đụng tới); chọn `N` hoặc nhấn Enter thì không cài gì và không hỏi lại (câu trả lời lưu ở `onboarding.json` trong thư mục state). Không hỏi khi chạy ngoài terminal tương tác hoặc `CI=true`; tắt hẳn bằng `--no-skill-prompt` hoặc `BRIDGE_NO_SKILL_PROMPT=1`. Cài sau bất kỳ lúc nào bằng `agy-mcp-bridge skill install --client both`. Lỗi khi cài chỉ được báo, server vẫn khởi động. Khi đã cài mà gói có skill mới hơn, bridge hỏi riêng một lần cho việc cập nhật (chỉ với bản cũ do gói phát hành; bản bạn tự sửa không bao giờ được đề nghị hay bị đụng tới).

**Cập nhật:** khi chạy bản cài từ npm, bridge hỏi npm registry bản mới nhất (tối đa một lần mỗi ngày, timeout 3 giây, lỗi mạng thì bỏ qua). Có bản mới và đang ở terminal tương tác thì hỏi `Update now with "npm install -g agy-mcp-bridge@X"? [y/N]`: chọn `y` mới chạy `npm install -g`, rồi thoát để bạn chạy lại bản mới; chọn `n` thì chạy tiếp và hỏi lại sau 24 giờ. Không bao giờ tự cập nhật âm thầm; ngoài terminal tương tác chỉ in thông báo; khi server đang chạy, giao diện web và log hiện thông báo kèm lệnh `agy-mcp-bridge update` (lệnh này, hoặc `update --check` để chỉ xem). Tắt hoàn toàn bằng `--no-update-check` hoặc `BRIDGE_NO_UPDATE_CHECK=1`; tự tắt khi `CI=true` và với bản clone từ git. Lần kiểm tra chỉ gửi một request GET tên gói tới registry (lộ địa chỉ IP như mọi lần `npm view`).

**Phát hành tự động lên npm:** mỗi lần push hoặc merge vào `main`, workflow [publish.yml](.github/workflows/publish.yml) chạy CI trên Windows/Linux với Node 20/22, gồm test và cài thử gói đã pack. Khi toàn bộ CI đạt, job release dùng Node 24 chạy `npm version patch --no-git-tag-version`, commit hai manifest, tạo tag `vX.Y.Z`, push commit/tag và chạy `npm publish`. Bạn không cần tự tăng version, tạo tag hay đăng nhập npm cho mỗi lần phát hành. Nếu CI lỗi thì không tăng version và không publish. PR chỉ chạy [CI](.github/workflows/ci.yml), chưa phát hành.

Cấu hình một lần tại [Settings của gói npm](https://www.npmjs.com/package/agy-mcp-bridge/access), phần **Trusted Publisher**, chọn GitHub Actions:

- Organization or user: `thanhdo257205`
- Repository: `MCP-bridge`
- Workflow filename: `publish.yml` (không nhập đường dẫn đầy đủ)
- Environment name: để trống
- Cho phép **npm publish** để phát hành trực tiếp.

Workflow dùng OIDC với `id-token: write` riêng cho job publish, không cần npm token trong GitHub Secrets hay OTP mỗi lần chạy. Job này cần `contents: write` để ghi commit tăng version và tag bằng `GITHUB_TOKEN`; push do token này tạo không kích hoạt workflow push khác, nên không tạo vòng lặp phát hành. npm tự tạo provenance cho bản phát hành. Xem [tài liệu Trusted Publishing](https://docs.npmjs.com/trusted-publishers/). Việc cấp quyền lần đầu có thể yêu cầu 2FA; không đưa token hoặc OTP vào repo.

Từ bản clone trên nhánh `main`, chỉ cần commit và push code như bình thường:

```bash
git checkout main
git pull --ff-only
npm ci
# Chỉnh sửa code, git add và git commit như bình thường
git push origin main
```

Theo dõi [Actions → CI and npm release](https://github.com/thanhdo257205/MCP-bridge/actions/workflows/publish.yml). Ví dụ `0.1.1` sẽ thành `0.1.2` sau một lần push có CI đạt. Sau phát hành, chạy `git pull --ff-only` để lấy commit version do bot tạo về máy trước khi sửa tiếp; nếu có commit local riêng thì rebase theo quy trình Git của bạn. Nếu `main` được bảo vệ và từ chối bot push, job sẽ lỗi trước khi publish; cần một chính sách cho phép bot ghi commit release, không tự động tắt bảo vệ nhánh.

Các job release được tuần tự hóa. Khi nhiều push liên tiếp, CI cũ không phát hành nếu `main` đã có code mới hơn; bản mới nhất chỉ phát hành sau khi CI của chính nó đạt. Push commit version và tag là một giao dịch atomic, không force-push: nếu ai đó push code trong lúc tăng version, giao dịch bị từ chối và không publish code chưa kiểm thử. Chỉ hai manifest được đổi version sau CI; mọi thay đổi code khác đều bị chặn.

Nếu publish lỗi sau khi commit version/tag đã được push, dùng **Re-run failed jobs** của lượt workflow đó: job nhận diện commit release từ cùng SHA nguồn, giữ nguyên version và tag thay vì tăng lần nữa. Registry đã có version đó thì bỏ qua publish; lỗi mạng/registry khác không bị coi nhầm là chưa đăng. Nếu đã có push mới hơn, lượt cũ bị bỏ qua và CI mới phụ trách phát hành. Không chạy `npm publish` hoặc tự tạo tag release song song; trigger theo tag cũ đã được thay bằng trigger theo `main`. Kiểm tra kết quả bằng `npm view agy-mcp-bridge version`; registry có thể mất vài phút để xử lý. Gói sử dụng giấy phép MIT và chứa file `LICENSE`.

## Quickstart

Requires Git, Node.js ≥20 and a logged-in Antigravity CLI `agy` 1.4.x on PATH (real agent execution was verified on 1.4.3 and 1.4.7). The longer sections below use PowerShell; the POSIX equivalents are:

```bash
git clone https://github.com/thanhdo257205/MCP-bridge.git && cd MCP-bridge
agy --version && npm ci && npm run build
npm start                                   # terminal 1: server on http://127.0.0.1:3000/mcp
npm run check                               # terminal 2, same clone: calls antigravity_environment
```

Then allow a workspace in `config/workspaces.json` (created empty on first run, git-ignored), register the client ([Codex](#3-kết-nối-codex), [Claude Code](#4-kết-nối-claude-code)) and install the [skill](#9-skill-giao-tiếp-với-antigravity). Bash equivalents of PowerShell snippets: `$env:X = 'v'` → `export X=v`; `Remove-Item Env:X` → `unset X`.

> **Không có xác thực.** Bridge chỉ nghe trên `127.0.0.1`, nhưng bất kỳ tiến trình nào chạy trên cùng máy với cùng user đều có thể gọi tool để điều khiển agent. Không mở cổng ra ngoài, không đặt sau reverse proxy công khai, và chỉ dùng trên máy bạn kiểm soát.

## 1. Cài đặt và khởi động

Yêu cầu Git, Node.js ≥20, npm và Antigravity CLI **1.4.x** đã đăng nhập, có lệnh `agy` trong PATH và đủ cờ bắt buộc trong help. Patch 1.4.3 và 1.4.7 đã được xác minh thực thi agent thật; patch 1.4.x khác vẫn chạy nhưng có cảnh báo trong log và environment; major/minor khác bị từ chối. SDK chính thức: server 2.3.1, Node HTTP adapter 2.1.1; lockfile khóa dependency. Các lệnh bên dưới dùng PowerShell trên Windows. Xem [thay đổi hardening và giới hạn kiểm chứng](docs/HARDENING.md).

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

`dev` build rồi chạy HTTP; hiện không có hot reload. Sau khi sửa source, Ctrl+C rồi chạy `npm run dev` lại. Không tự restart để tránh gián đoạn task đang sửa code.

Server giữ terminal hoạt động tới khi **Ctrl+C**, SIGTERM hoặc lỗi nghiêm trọng. Việc đóng Codex, Claude Code hoặc stdin của bridge không dừng HTTP server. Đóng cưỡng bức cửa sổ terminal không tương đương shutdown an toàn.

Mặc định bind duy nhất `127.0.0.1:3000`. Khi cổng còn trống, terminal in:

```text
[bridge] HTTP server: http://127.0.0.1:3000
[bridge] MCP endpoint: http://127.0.0.1:3000/mcp
[bridge] Health check: http://127.0.0.1:3000/health
[bridge] No authentication: any local process running as this user can control the bridge. Keep it on this machine.
[bridge] Web UI: http://127.0.0.1:3000/ui (open in a browser on this machine)
```

Dòng `Web UI` là đường dẫn tới giao diện web; nhấn giữ Ctrl (hoặc Cmd) và bấm vào nó trong terminal hỗ trợ liên kết để mở trình duyệt.

Cổng bị chiếm: server báo lỗi, thoát mã 1, không tự đổi cổng hoặc địa chỉ bind. Chọn cổng khác:

```powershell
$env:PORT = '3001'
npm start
```

Muốn hệ điều hành chọn một cổng đang trống, đặt `PORT='0'`. Đây là lựa chọn minh bạch do người dùng chỉ định: đọc URL thực tế được in ở terminal rồi cập nhật tất cả client. `PORT` nhận số nguyên 0–65535, không nhận giá trị rỗng. Xóa override để về mặc định: `Remove-Item Env:PORT`.

## 2. Không xác thực và health check

Bridge **không có bearer token**. `/mcp` và `/health` nhận request trực tiếp từ loopback. Đây là lựa chọn có chủ đích cho công cụ cục bộ; đổi lại, bất kỳ tiến trình nào trên cùng máy với cùng user đều có thể dùng tool, xem và hủy task, hoặc tắt server. Chỉ chạy bridge trên máy cá nhân hoặc máy bạn kiểm soát hoàn toàn.

Các lớp bảo vệ còn lại: chỉ bind `127.0.0.1`, kiểm tra `Host`/`Origin`, giới hạn body, timeout, allowlist workspace và allowlist biến môi trường cho tiến trình con.

Mở **terminal thứ hai tại thư mục gốc của cùng bản clone** (nơi có `package.json`):

```powershell
Invoke-RestMethod 'http://127.0.0.1:3000/health'
npm run check
```

`npm run check` không khởi động server hay gọi AI; nó kết nối HTTP và gọi `antigravity_environment`. Khi server tắt hoặc URL sai, script thoát mã 1 và hướng dẫn chạy `npm start`, kiểm tra PORT/URL, rồi kết nối lại.

Với cổng khác, ví dụ 3001:

```powershell
$env:BRIDGE_MCP_URL = 'http://127.0.0.1:3001/mcp'
npm run check
Invoke-RestMethod 'http://127.0.0.1:3001/health'
```

`BRIDGE_MCP_URL` dành cho script check; URL của Codex và Claude Code phải cập nhật riêng. Child `agy` chỉ nhận allowlist môi trường; tên chứa `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY` bị chặn mặc định. Chỉ dùng `extra_env_passthrough` cho biến thực sự cần. Xem danh sách và ví dụ trong [HARDENING.md](docs/HARDENING.md).

## 3. Kết nối Codex

> Muốn có sẵn đúng lệnh cho máy của bạn (cổng, PowerShell/cmd/bash) chạy `agy-mcp-bridge setup codex` hoặc `setup claude` (hoặc `setup both`, thêm `--port` và `--shell` nếu cần). Lệnh chỉ in ra, không sửa cấu hình của Codex hay Claude Code; bạn xem rồi tự áp dụng.

**Các đoạn dưới là thay đổi đề xuất, chưa áp dụng.** Trình bày để chủ máy duyệt trước khi chạy lệnh ghi cấu hình. Mẫu: [config/codex-mcp.windows.toml](config/codex-mcp.windows.toml).

```toml
[mcp_servers.antigravity]
url = 'http://127.0.0.1:3000/mcp'
startup_timeout_sec = 30
tool_timeout_sec = 115
enabled = true
```

File cấu hình Codex mặc định là `~/.codex/config.toml` (trên Windows: `$env:USERPROFILE\.codex\config.toml`). Nếu bạn đã đặt biến môi trường `CODEX_HOME`, dùng file `config.toml` trong thư mục đó. Nếu đã có mục antigravity kiểu command/args, thay mục đó bằng HTTP sau khi được duyệt, không tạo mục trùng. Không còn command/args nên Codex không spawn bridge.

Sau khi được duyệt có thể dùng CLI thay cho merge TOML (CLI dùng timeout mặc định, thêm timeout bằng TOML nếu cần):

```powershell
codex mcp add antigravity --url 'http://127.0.0.1:3000/mcp'
codex mcp get antigravity
codex mcp list
codex
```

Khởi chạy Codex ở terminal bất kỳ. Trong phiên mới, yêu cầu gọi `antigravity_environment`; kiểm tra phiên bản thuộc 1.4.x, đủ cờ và các cảnh báo patch. `codex mcp list/get` xác nhận cấu hình, không thay thế một tool call thật.

Ngắt kết nối: thoát phiên Codex; server và task vẫn chạy. Muốn bỏ cấu hình, sau khi duyệt chạy `codex mcp remove antigravity`, rồi mở phiên mới. Hoặc đặt `enabled=false` trong block và mở lại phiên. Server chỉ dừng khi bạn Ctrl+C tại terminal server.

Khi đổi cổng, sửa `url` rồi mở phiên mới. Khi server tắt, Codex báo lỗi kết nối/MCP startup. Không có tiến trình HTTP nào có thể tự trả hướng dẫn khi nó đã tắt; chạy `npm run check` để có chẩn đoán và hướng dẫn cụ thể, sau đó `npm start` ở terminal server và mở lại phiên Codex.

Tham khảo [tài liệu MCP chính thức của Codex](https://developers.openai.com/codex/mcp/).

## 4. Kết nối Claude Code

Mẫu cấu hình đề xuất ở [config/claude-mcp.http.json](config/claude-mcp.http.json), chưa ghi vào cấu hình hiện có:

```json
{
  "mcpServers": {
    "antigravity": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

Sau khi duyệt, từ thư mục project của bạn:

```powershell
claude mcp add --transport http --scope local antigravity 'http://127.0.0.1:3000/mcp'
claude mcp get antigravity
claude mcp list
claude
```

`--scope local` chỉ cấu hình cho project và người dùng hiện tại. Mẫu JSON wrapper dành cho `.mcp.json`; không tự tạo file đó trong repository ứng dụng.

Trong Claude Code dùng `/mcp` để xem trạng thái, reconnect hoặc disable server, và gọi `antigravity_environment` để kiểm tra tool. Nếu server tắt, `/mcp` hiển thị lỗi kết nối; chạy `npm run check`, bật server bằng `npm start`, rồi reconnect qua `/mcp` hoặc mở lại phiên. Thoát Claude Code/disable kết nối không hủy task.

Gỡ sau khi duyệt: `claude mcp remove antigravity --scope local`. Đổi cổng: cập nhật URL trong cùng entry, hoặc remove rồi add lại URL mới, sau đó reconnect. Không cần dừng server vì client ngắt kết nối.

Tham khảo [tài liệu MCP chính thức của Claude Code](https://code.claude.com/docs/en/mcp). Các phiên bản CLI và kết quả đã kiểm chứng được ghi trong [báo cáo khảo sát](docs/VERIFICATION.md). Sau khi cấu hình trên máy của bạn, hãy gọi tool thật từ từng client để kiểm tra kết nối; kiểm thử protocol bằng SDK không thay thế bước này.

## 5. Cho phép workspace và giao task

`config/workspaces.json` là file cục bộ, không nằm trong git; lần chạy đầu tự tạo với `allowed_workspaces: []` (không file nào bị ghi đè). Chỉ thêm đường dẫn tuyệt đối đã được cấp quyền; [mẫu](config/workspaces.example.json). Có thể chọn file JSON khác qua env `ANTIGRAVITY_BRIDGE_CONFIG`; restart server để áp dụng. Đừng giao workspace chứa chính source bridge đang chạy.

Đăng ký client thành công chưa cấp quyền sửa file cho Antigravity. Lần thử thật trước đây bị `write_file` từ chối. Cần phê duyệt rule tối thiểu trong settings Antigravity hoặc cấp quyền qua phiên tương tác, rồi kiểm thử lại. Ví dụ **chưa áp dụng**:

```json
{"permissions":{"allow":["write_file(C:/absolute/path/to/approved-project/)"]}}
```

Merge rule cần thiết vào settings, không thay toàn bộ cấu hình; không dùng wildcard global. Muốn Antigravity tự làm mà không bị từ chối từng thao tác, chủ máy có thể nâng mức quyền trong giao diện web (Cài đặt → Quyền của Antigravity, xem mục 10); mặc định vẫn là không bypass. Test commands phải được cho phép riêng; Codex có thể tự chạy test. Deploy/xóa dữ liệu/thay đổi hệ thống yêu cầu xác nhận tương tác riêng và không thuộc task thông thường. Chi tiết hạn chế CLI ở [docs/VERIFICATION.md](docs/VERIFICATION.md).

Luồng sử dụng trong Codex hoặc Claude Code:

1. Đọc code và Git status trước task; chia task nhỏ, rõ file được sửa và tiêu chí nghiệm thu.
2. Gọi `antigravity_delegate` với arguments mẫu ở dưới.
3. Lưu `task_id`; gọi `antigravity_task_wait` (mỗi lần chờ tối đa `max_wait_seconds`, mặc định 55 giây, trả sớm khi task xong) hoặc `antigravity_task_status`, rồi lấy `antigravity_task_output`.
4. Nếu client bị đóng, bật lại client, gọi environment để xem `recent_tasks`, rồi query task ID cũ. Không giao trùng task khi chưa kiểm tra trạng thái.
5. Tech Lead review diff thực tế, gồm file untracked, chạy test và đánh giá từng tiêu chí. Nếu chưa đạt, giao task sửa tiếp.

```json
{
  "task": "Sửa hàm parseCount trong src/count.ts để từ chối số âm. Chỉ sửa hàm này và test liên quan. Không chạy lệnh; Tech Lead tự test. Báo cáo file đã sửa và vấn đề còn lại.",
  "workspace": "C:/absolute/path/to/approved-project",
  "acceptance_criteria": ["Số âm trả lỗi validation hiện hành", "0 và số nguyên dương giữ hành vi cũ"],
  "timeout_seconds": 300,
  "agent": "codex",
  "autonomy": "auto"
}
```

Task chạy song song an toàn dùng `isolation: "worktree"` và khai báo đúng các đường dẫn agent được sửa trong `owns`:

```json
{
  "task": "Thêm validate cho parser và test tương ứng.",
  "workspace": "C:/absolute/path/to/approved-project",
  "acceptance_criteria": ["Test mới chạy qua"],
  "agent": "codex",
  "isolation": "worktree",
  "owns": ["src/parser", "test/parser.test.ts"]
}
```

- `agent`: id lấy từ `agents_list` (`antigravity`, `codex`). Bỏ trống thì dùng agent ưu tiên đang available; agent được chỉ định nhưng không available sẽ báo lỗi, không âm thầm đổi agent.
- `isolation`: `none` (mặc định, sửa trực tiếp workspace, chạy tuần tự toàn cục) hoặc `worktree` (tạo branch `bridge/<task_id>` trong `.bridge-state/worktrees/<task_id>`, chạy song song tối đa `max_parallel_worktrees`). Task worktree bắt buộc có `owns`.
- `owns`: đường dẫn tương đối trong workspace. Sau khi agent xong, bridge so diff thực tế với danh sách này; file ngoài phạm vi được báo trong `scope.out_of_scope` và task cần review. Bridge **không tự merge** worktree.
- `autonomy`: `suggest` | `auto` | `full` (mặc định lấy `default_autonomy`, thường là `auto`). Đây là chỉ dẫn cho agent CLI; các hành động phá hủy, deploy, xóa dữ liệu, đọc credential và thay đổi hệ thống vẫn bị cấm tuyệt đối, không có cờ bypass permission.

| Tool | Công dụng |
|---|---|
| `antigravity_environment` | CLI/version/allowlist/giới hạn, danh sách agent, mức song song và recent_tasks để tìm lại task ID |
| `agents_list` | Agent đã dò được, capabilities, available/version, agent mặc định và giới hạn worktree; chỉ đọc |
| `antigravity_delegate` | Nhận task, workspace, acceptance_criteria, context?, timeout_seconds?, agent?, isolation?, owns?, autonomy?; trả `running` (hoặc `queued` nếu hết slot) cùng task_id |
| `antigravity_task_status` | Trạng thái/process/thời gian/lỗi/denied_actions/số byte theo task_id, không kèm log (rẻ để poll) |
| `antigravity_task_wait` | Chờ tối đa `wait_seconds` (1 đến `max_wait_seconds`, mặc định là mức tối đa, 55 giây) tới khi task kết thúc, trả cùng nội dung như status; còn chạy thì gọi lại |
| `antigravity_task_output` | Phản hồi cuối, stdout/stderr, lỗi, denied_actions, truncation theo task_id |
| `antigravity_cancel_task` | Hủy cây tiến trình thuộc task; không rollback thay đổi file |

`completed` chỉ là CLI chạy xong và có kết quả hợp lệ. Luôn `review_required=true`, `acceptance_verified=false`. SUCCESS/exit 0 vẫn có thể bị bridge đánh dấu failed do permission denial hoặc timeout. Prompt mẫu review/sửa tiếp: [docs/PROMPTS.md](docs/PROMPTS.md).

### Để Codex/Claude tự chia việc dễ khó và tiết kiệm token (chế độ tùy chọn)

Mặc định agent chỉ giao việc khi bạn nhắc Antigravity. Nếu muốn agent tự quyết định, hãy nói rõ trong cuộc trò chuyện, ví dụ "tự phân loại việc" hoặc "tiết kiệm token bên Codex". Khi đó agent làm theo quy trình sau (do skill quy định):

- **Việc dễ** (một mục tiêu, tối đa 3 file kèm test, tiêu chí nghiệm thu cụ thể, không phụ thuộc ngữ cảnh ngoài repo): giao trọn cho Antigravity đọc file cần thiết, sửa, chạy các kiểm tra bạn đã cho phép và báo cáo; agent xem diff. Antigravity chỉ chạy được lệnh khi mức quyền `agy_permissions` cho phép; ở mức mặc định lệnh bị từ chối, nên agent tự chạy kiểm tra.
- **Việc khó** (thiết kế, nhiều file phụ thuộc nhau, yêu cầu mơ hồ, lỗi chưa rõ nguyên nhân): agent tự phân tích phạm vi và thiết kế trước, chỉ giao phần triển khai đã đủ rõ để viết tiêu chí nghiệm thu, từng task một; phần rủi ro tự làm hoặc review kỹ.
- **Không bao giờ giao** (kể cả trong chế độ này): bảo mật, xác thực, secret; di chuyển hoặc xóa dữ liệu; triển khai; phụ thuộc, build, CI; thay đổi API công khai. Không chắc thì coi là việc khó.
- **Tránh đọc trùng:** không đọc cả codebase trước khi giao; chỉ đưa ngữ cảnh cần thiết. **Theo dõi ít:** dùng vài lượt chờ dài, lấy báo cáo khi xong, không đọc log liên tục.
- **Kiểm tra vừa đủ:** kết quả kiểm tra do Antigravity báo chỉ là gợi ý, không phải bằng chứng (bridge luôn báo `acceptance_verified=false`). Agent có thể bỏ qua việc chạy lại các kiểm tra nhỏ, ít rủi ro mà Antigravity báo đã qua, nhưng **tự chạy một lần** kiểm tra chính bao phủ thay đổi (test, build hoặc lint) ở cuối, luôn làm vậy với thay đổi rủi ro, và chạy lại sau mọi sửa đổi thêm của chính nó.
- **Báo cáo ngắn:** file đã đổi, kết quả kiểm tra, lỗi còn lại, và phần nào do Antigravity làm, phần nào do agent làm; nói một dòng lý do trước khi giao. Mọi diff giao đi đều được xem lại; task giao đi lỗi, hết giờ hoặc kém thì agent tự làm tiếp thay vì gửi lại nhiều lần.

Bạn kết thúc chế độ bất cứ lúc nào bằng cách bảo agent tự làm hết; công tắc giao việc và lời từ chối của bạn luôn có hiệu lực trước. Đây là chỉ dẫn cho agent, không phải rào chắn kỹ thuật, và việc phân loại dựa trên phán đoán của agent. Các tình huống kiểm tra thủ công ở [docs/SKILL-EVAL.md](docs/SKILL-EVAL.md) (11 đến 17).

### Khi chỉ muốn Codex/Claude tự làm

- **Công tắc cứng (khuyến nghị):** `npm run delegation -- off` chặn mọi lần giao task mới ngay lập tức, không cần restart. `npm run delegation -- on` bật lại, `-- status` xem trạng thái. Có thể đặt `BRIDGE_DELEGATION=off` trước `npm start` (giá trị khác `on`/`off` cũng bị coi là tắt). Khi tắt, `antigravity_delegate` trả lỗi nêu rõ "disabled by the bridge owner" và `antigravity_environment` trả `delegation: {enabled: false, reason}`. Task đang chạy không bị dừng và vẫn xem/hủy được.
- **Chỉ dẫn cho agent:** skill có mục "When NOT to delegate": agent không giao việc khi bạn bảo tự làm, khi bạn không nhắc Antigravity, hoặc khi công tắc đang tắt. Đây là chỉ dẫn, không phải rào chắn; muốn chắc chắn hãy dùng công tắc. Chạy lại `npm run skill:install` sau khi pull để cập nhật skill.
- Muốn tắt theo từng client: `enabled=false` trong cấu hình Codex hoặc `/mcp` trong Claude Code (xem mục 3, 4).

## 6. Vòng đời, giới hạn và dừng an toàn

TaskManager thuộc HTTP server, không thuộc phiên MCP. Server sử dụng handler stateless cho kết nối MCP; mọi request truy cập cùng TaskManager. Disconnect, DELETE session, request cancellation hoặc client thoát không tự hủy task đã tiếp nhận. Nếu mất response giao task, tra `recent_tasks` trước khi thử lại. Mọi client kết nối tới cùng bridge đều xem/hủy được task của nhau.

**Hàng đợi:** task `isolation: "none"` chạy tuần tự toàn cục. Task `isolation: "worktree"` chạy song song tối đa `max_parallel_worktrees` (mặc định 2, cấu hình 1–8 trong `config/workspaces.json`); hai lane không chạy chồng lên nhau (đang có task normal thì worktree xếp hàng và ngược lại). Khi bridge đang bận, tối đa `max_queued_tasks` task nữa (mặc định 3, cấu hình 0–20) được nhận với trạng thái `queued` và chạy theo thứ tự gửi. `0` trả về hành vi cũ: từ chối ngay với "busy". Task đang chờ chưa có tiến trình, chưa đụng file, có thể hủy; thời hạn (`timeout`) chỉ tính từ lúc bắt đầu chạy. Nếu công tắc giao việc bị tắt trước khi đến lượt thì task bị hủy; server dừng thì hủy hết; crash giữa chừng thì task đang chờ được nạp lại ở trạng thái `failed` ("never started").

Task worktree tạo branch `bridge/<task_id>` và thư mục `.bridge-state/worktrees/<task_id>` tại HEAD của repo; thay đổi chưa commit trong workspace gốc **không** được copy sang. Sau khi task kết thúc, bridge so diff với `owns`, giữ nguyên worktree và branch để Tech Lead review/merge thủ công. Bridge không tự merge, không tự xóa branch, và không chạy hook của repo khi tạo worktree. Chỉ dùng worktree cho repo đã có ít nhất một commit; workspace là thư mục con của repo vẫn được hỗ trợ.

Mặc định giữ 50 task (tối đa cấu hình 200); task cũ hoàn tất bị loại bỏ. Bản ghi task được lưu tại `.bridge-state/tasks/<task_id>.json` (mode 0600 trên POSIX; nội dung đã qua lọc secret) và nạp lại khi khởi động, nên tra được kết quả sau restart. Task đang chạy lúc server dừng đột ngột được nạp lại với trạng thái `failed` ("Bridge restarted…"): tiến trình agent không được khôi phục, hãy kiểm tra diff dở dang. Đây là lịch sử kết quả, không phải durable task recovery. Task vẫn timeout nếu không có client theo dõi. Lane normal giữ khóa giữa các process dùng cùng bản cài tại `.bridge-state/execution.lock`; lane worktree dựa vào branch riêng và không dùng khóa này.

Nhấn **Ctrl+C một lần** tại terminal server:

1. Ngừng lắng nghe kết nối và không nhận task mới.
2. Hủy ngay các task đang chạy, dọn cây process do server khởi tạo; không đợi task tự hoàn thành.
3. Đóng MCP handler, cho kết nối đang có tối đa 3 giây để drain sau khi cleanup; sau đó đóng cưỡng bức socket còn lại.
4. In `[bridge] Stopped` khi thành công. Không rollback file đã sửa. Xem diff trước lần chạy tiếp theo.

Nếu cleanup thất bại, báo lỗi và giữ execution lock khi process chưa đóng. Khi khởi động hoặc lấy lock, bridge chỉ tự thu hồi nếu đọc được owner hợp lệ, cả `server_pid` lẫn `child_pid` đều đã chết và record khớp lock. Lệnh `agy-mcp-bridge unlock` dùng cùng kiểm tra; PID còn sống, thiếu thông tin hoặc quyền sở hữu không rõ thì giữ lock và in lý do. Bridge không kill process Antigravity khác. PID có thể được tái sử dụng nên trường hợp không rõ cần kiểm tra thủ công. Force kill/OS crash vẫn không bảo đảm cleanup: chưa có Windows Job Object. POSIX gửi SIGTERM cho nhóm process, chờ tối đa 8 giây rồi SIGKILL; Windows giữ taskkill cây PID. Ctrl+C tiếp trong lúc cleanup chỉ báo `cleanup in progress, please wait`.

Giới hạn mặc định: CLI task 300s, tối đa 900s; watchdog của bridge cộng thêm 10s để CLI tự báo timeout trước. Chủ máy nâng mức tối đa (và mặc định) lên tới 3600s bằng `max_timeout_seconds` / `default_timeout_seconds` trong file cấu hình (khởi động lại bridge); mỗi task đặt `timeout_seconds` riêng, không vượt mức tối đa đó. Task hết thời hạn không bị hoàn tác: file đã sửa trước đó vẫn nằm trên đĩa (xem "Thay đổi trong workspace" hoặc `git diff`), trạng thái là `timeout`, và skill dặn Codex/Claude giao task mới hẹp hơn cho phần còn lại thay vì gửi lại y nguyên. Task lớn nên chia nhỏ hơn là chỉ tăng thời hạn. Output mỗi stream 256 KiB (cấu hình 1 KiB–1 MiB), vượt trần sẽ hủy task và trả failed/truncated. Tổng task JSON vẫn tối đa 24000 ký tự; HTTP body tối đa 128 KiB. Prompt mặc định đi qua argv với print/json (`prompt_transport: "argv"`, đường đã chạy thật với `agy` 1.4.3 và 1.4.7). Đặt `prompt_transport: "stdin"` để gửi qua stdin stream-json, không lộ prompt trong danh sách tiến trình; chế độ này chưa được chạy thử với `agy` thật, và stream gồm cả init/progress nên có thể chạm output cap sớm hơn. Snapshot log được cập nhật tối đa mỗi giây và flush khi kết thúc. Không dùng CLI detach/remote-control API chưa được xác minh.

## 7. Bảo mật và vận hành

Chỉ listen `127.0.0.1`, không có tùy chọn bind LAN trong bản này. Host phải đúng địa chỉ/cổng thực tế; Origin khác bị từ chối; không bật CORS cho website ngoài. **Không có xác thực**: mọi tiến trình cục bộ cùng user đều có thể gọi tool, đọc task, điều khiển agent và tắt server. Đây là mô hình tin cậy cục bộ có chủ đích; không mở cổng, không đặt sau proxy công khai. Không log HTTP headers/body.

Cách ly worktree là ranh giới **quy trình**, không phải sandbox OS: agent vẫn chạy dưới quyền user hiện tại. Bridge tạo worktree trong `.bridge-state/worktrees` với `core.hooksPath` rỗng, so diff sau khi chạy và báo `scope.out_of_scope`; file ngoài `owns` không bao giờ được tự merge. Codex chạy với `--sandbox workspace-write`; các hành động cần approval vẫn thất bại thay vì được bypass. Không dùng `--dangerously-*`, `--yolo` hoặc bất kỳ cờ bỏ qua permission nào. Deploy, publish, xóa dữ liệu, push nhánh bảo vệ, đọc credential và thay đổi hệ thống ngoài workspace là hành động bị cấm tuyệt đối, không phụ thuộc `autonomy`.

Allowlist kiểm tra realpath, boundary, traversal; link/junction trong thành phần đường dẫn đầu vào vẫn bị từ chối. Trong cây, link phải resolve được vào cùng workspace; không theo alias/cycle. Quét bỏ qua nội dung thư mục `node_modules` và `.git`; trần 200000 chỉ tính các entry còn lại. Task từ queue được kiểm tra lại trước launch. **Đây không phải OS sandbox**: đặc biệt nội dung hai thư mục được bỏ qua không được kiểm tra, và tiến trình khác vẫn có thể đổi link sau preflight. Quyền agent/hooks/MCP và file ngoài workspace vẫn cần kiểm soát OS/CLI phù hợp. Lọc output không nhận ra mọi bí mật; không đưa secret vào task.

Để truy cập từ máy khác, cần thiết kế riêng TLS, xác thực/authorization và cách ly workspace. Bản này không triển khai remote/LAN; không đổi bind sang 0.0.0.0 hoặc mở firewall để né lỗi cổng.

Các lỗi thường gặp:

- `Port is already in use`: chọn PORT khác, cập nhật URL cả hai client.
- 403: sai Host/Origin; dùng đúng URL 127.0.0.1 được in ra, không đi qua proxy/alias.
- Connection refused/fetch failed: server tắt hoặc sai cổng; chạy check, bật lại server và reconnect.
- CLI unsupported: kiểm tra agy path/version/help; environment vẫn có thể hoạt động dù không giao được task.
- Agent unavailable: gọi `agents_list`; kiểm tra `codex --version` và `codex exec --help`, hoặc tên/`agents.enabled` trong cấu hình.
- Worktree bị từ chối: workspace phải là git repo có ít nhất một commit; `owns` phải là đường dẫn tương đối, không chứa `..`.
- `scope.out_of_scope` khác rỗng: agent sửa file ngoài phạm vi; review worktree, không merge tự động.
- `denied_actions`: Antigravity chưa cho phép thao tác; xin quyền tối thiểu, không bỏ permission check.
- Workspace bị từ chối: kiểm tra allowlist, link/junction hoặc số entry vượt trần.
- Timeout/canceled/output limit: có thể có diff dở dang; review trước khi giao task tiếp theo.

## 8. Kiểm thử và cấu trúc source

```powershell
npm test
npm run test:live
```

`npm test` (cũng chạy trong [CI](.github/workflows/ci.yml) trên Ubuntu và Windows, Node 20/22): unit/integration dùng executable giả, không gọi AI. Bao gồm lifecycle/security cũ và HTTP startup/port conflict/PORT tùy chọn/Host/Origin/body limit/kết nối hai protocol era/client reconnect/task completion/cancel/server shutdown.

`test:live`: **gọi AI thật**, dùng cached login/quota. Test harness khởi động HTTP server riêng với PORT=0 và scratch workspace, dùng official SDK HTTP client, ngắt/kết nối lại khi task chạy, xác minh `BRIDGE_SMOKE_OK` và sentinel không đổi, hủy task thật, rồi kiểm tra shutdown có task đang chạy. Trên Windows, harness phát event SIGINT vào đúng handler của entry point qua IPC riêng của harness; kiểm tra Ctrl+C terminal được ghi riêng trong báo cáo. Đây không phải yêu cầu client production tự khởi động server. Kết quả ở `test-results/live-report.json`; phần sửa file thật vẫn bị chặn đến khi cấp quyền.

`src/index.ts`: HTTP entry; `src/http.ts`: listener/routing/shutdown; `src/runtime.ts`: CLI và TaskManager dùng chung; `src/agents`: adapter Antigravity/Codex, registry và contract; `src/isolation`: tạo worktree và kiểm tra phạm vi `owns`; `src/tools`: tool; `src/antigravity`: child process; `src/security`: validation/workspace/redaction; `src/tasks`: lifecycle/lock/output; `scripts/check.ts`: kiểm tra server đang chạy; `scripts/live.ts`: AI smoke test. Không thay cấu hình Codex/Claude Code/Antigravity trong test.

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

Installer chỉ ghi `SKILL.md`, không sửa config MCP, allowlist, AGENTS.md/CLAUDE.md hay settings Antigravity. Nội dung giống nhau thì không ghi lại (khác nhau kiểu xuống dòng CRLF/LF không tính là khác). Khi file đã cài khác nội dung, bridge phân biệt hai trường hợp bằng danh sách hash `skills/known-versions.json` (sha256 của mọi bản `SKILL.md` đã phát hành):
- **Bản cũ do gói này phát hành** (khớp một hash trong danh sách): `skill install` báo cần `--update`; chạy `agy-mcp-bridge skill install --client both --update` (hoặc `npm run skill:install -- --client both --update`) sẽ thay bằng bản mới, ghi nguyên tử qua file tạm. Khi chạy server lần đầu sau khi có skill mới, bridge cũng hỏi `Update them now? [y / N]` đúng một lần cho mỗi bản skill mới (không hỏi lại nếu bạn trả lời không, cho tới khi có bản mới hơn).
- **Bản bạn tự sửa** (không khớp bản nào): không bao giờ bị ghi đè hay xóa, kể cả khi có `--update`; lệnh báo lỗi để bạn tự review/gộp.

Với client có nhiều đích, mọi đích được quyết định trước khi ghi bất cứ file nào, nên không có trạng thái cập nhật dở. **Người bảo trì:** mỗi khi sửa `skills/antigravity-bridge/SKILL.md`, thêm sha256 của bản mới vào `skills/known-versions.json` (test `skill versions` báo đúng giá trị cần thêm); các hash cũ giữ nguyên để người đã cài bản cũ vẫn cập nhật được. Có thể copy thư mục skill vào đường dẫn discovery do client/môi trường của bạn hỗ trợ nếu không dùng vị trí mặc định.

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

Không cần đăng nhập: giao diện mở trực tiếp vì bridge không có xác thực. Trang chỉ dùng được từ loopback và bị chặn nếu `Host`/`Origin` không khớp. Đóng tab chỉ đóng giao diện, không dừng server; dùng nút **Tắt bridge** trong Cài đặt để dừng server và dọn tiến trình.

| Màn hình | Nội dung |
|---|---|
| Task | Tổng quan (trạng thái bridge, agent sẵn sàng, công tắc giao việc, số task đang chạy, mức song song); danh sách task; với mỗi task là cuộc trao đổi **Tech Lead → agent** (yêu cầu, tiêu chí nghiệm thu, ngữ cảnh, agent/cách ly/quyền tự duyệt) và **agent → Tech Lead** (phản hồi cuối, thao tác bị từ chối quyền, lỗi), log stdout/stderr, prompt đầy đủ, worktree/branch và kết quả kiểm tra `owns`. Tên client đã giao (từ `clientInfo` của MCP, hoặc User-Agent nếu client dùng giao thức cũ; có thể trống hoặc chỉ là `node`), trạng thái hàng đợi, lọc theo trạng thái và tìm kiếm. Cập nhật từng vùng nên bôi đen log/văn bản vẫn giữ nguyên khi task đang chạy; nút Hủy task cho task đang chạy hoặc đang chờ |
| Cài đặt | Công tắc giao việc (cùng cơ chế với `npm run delegation`, bị khóa nếu đặt `BRIDGE_DELEGATION`), endpoint MCP, thông tin từng agent, workspace được phép, giới hạn song song, lưu ý. Workspace, agent và giới hạn chỉ đọc: sửa trong `config/workspaces.json` rồi khởi động lại. Nút **Tắt bridge** dừng HTTP server, hủy task đang chạy hoặc đang chờ và dọn các tiến trình agent do bridge khởi tạo |

**Thay đổi trong workspace:** mỗi task có mục "Thay đổi trong workspace" (mở ra mới đọc, có nút Làm mới) liệt kê file đã sửa, xóa, file mới chưa theo dõi và số dòng thêm/xóa so với commit HEAD, kể cả thay đổi có từ trước khi task chạy. Chỉ hiện tên file và số dòng, không hiện nội dung, và chỉ cho workspace vẫn còn trong danh sách được phép. Để đọc an toàn, bridge **không bao giờ nạp cấu hình của repo**: `git status`/`git diff` thông thường chạy cả những lệnh do chính repo khai báo (`core.fsmonitor`, `filter.*.clean`, `diff.*.textconv`), mà Antigravity có quyền ghi file nên có thể cài sẵn vào `.git/config`; chỉ tắt trình diff ngoài là chưa đủ (đã thử: lệnh `filter clean` vẫn chạy). Thay vào đó bridge so sánh trong một thư mục git tạm với cấu hình rỗng, chỉ mượn kho đối tượng của repo, tắt cấu hình hệ thống/người dùng, và chỉ sao chép vài thiết lập xuống dòng/quyền file đã kiểm tra giá trị (`core.autocrlf`, `eol`, `filemode`, `symlinks`, `ignorecase`). Có test dựng repo "nhiễm độc" để chứng minh không lệnh nào bị chạy. Giới hạn: cần `git` trong PATH, chỉ tính khác biệt nội dung (file chỉ khác kiểu xuống dòng sau chuyển đổi không tính), tối đa 500 mục mỗi nhóm, không hiện submodule, và không thay thế việc tự xem diff đầy đủ.

Lưu ý bảo mật: nội dung yêu cầu và phản hồi được hiển thị dạng văn bản thuần, trang dùng CSP không cho script/style nội tuyến hay tải từ nơi khác, nên output của model không thể thực thi. Yêu cầu của Tech Lead được lưu cùng bản ghi task trong `.bridge-state/tasks` (đã qua lọc secret nhận diện được) để xem lại sau khi restart; đừng đưa secret vào task. Giao diện chỉ đọc, ngoại trừ các thao tác của chủ máy: hủy task, bật/tắt giao việc, tắt bridge và những mục trong Cài đặt. Mã nguồn giao diện nằm ở `ui/` (HTML/CSS/JS thuần, không cần build), phần máy chủ ở `src/ui/`.

**Chọn model:** mục Cài đặt → Model liệt kê các model lấy từ `agy models` (chỉ chạy khi mở trang Cài đặt). Chọn một model thì bridge truyền `--model <id>` cho mọi task mới; chọn "Mặc định của Antigravity" thì không truyền cờ nào. Có hiệu lực ngay, không cần khởi động lại; task đang chạy hoặc đang chờ giữ model đã chốt lúc nhận, và mỗi task ghi lại model đã dùng (hiện trong chi tiết task). Chỉ nhận id nằm trong danh sách của `agy models`; nếu không đọc được danh sách thì không cho đổi. Lựa chọn lưu ở `.bridge-state/model.json`. Codex/Claude không chọn được model theo từng task (không thêm tham số vào tool MCP nên không tốn thêm token).

**Ghi chú phát hành:** mỗi lần workflow phát hành, nó tạo một GitHub Release cho tag `vX.Y.Z` với ghi chú tự sinh gồm các pull request đã merge kể từ tag trước (tên PR là nội dung ghi chú, nên hãy đặt tên PR nêu rõ thay đổi). Xem tại trang Releases của repo. Các tag cũ chưa có release cũng được tạo bù, theo thứ tự từ cũ đến mới.

**Mức suy luận (effort):** mục Cài đặt → Mức suy luận chọn `--effort` truyền cho Antigravity: thấp (nhanh nhất), vừa, cao, rất cao, tối đa, hoặc mặc định (không truyền cờ). Mức thấp giúp task nhanh hơn nhưng suy luận ít hơn. Có hiệu lực ngay cho task mới, mỗi task ghi lại mức đã dùng, lưu ở `.bridge-state/effort.json`. Chưa kiểm chứng với `agy` thật ở chế độ `--print`. Kết hợp chọn model nhỏ hơn (ví dụ `gemini-3.8-flash-low`) để tăng tốc.

**Để Codex/Claude "nghỉ" trong lúc Antigravity làm (tiết kiệm token):** server không thể tự đánh thức Codex/Claude khi có kết quả: thông báo MCP từ server không khiến mô hình chạy, mô hình chỉ hành động khi được nhắn hoặc khi nó gọi tool. Cách gần nhất là **giữ Codex trong một lệnh chờ duy nhất**: `antigravity_task_wait` chặn cho đến khi Antigravity xong hoặc hết thời gian chờ, và trong lúc lệnh bị chặn Codex không tốn token. Có ba phần phối hợp:

1. **Thời gian chờ mỗi lần gọi** chỉnh trong giao diện web (Cài đặt → "Thời gian chờ mỗi lần Codex / Claude gọi"): 55 giây (mặc định), 5, 10, 15, 30 hoặc 60 phút; có hiệu lực ngay, không cần khởi động lại. Cũng đặt được bằng `max_wait_seconds` trong file cấu hình (lựa chọn trong giao diện được ưu tiên). Mức đang dùng được báo cho client qua `max_wait_seconds` của `antigravity_environment`.
2. **Thời hạn tool của client phải lớn hơn thời gian chờ**, nếu không client cắt lần chờ và báo timeout. Codex: đặt `tool_timeout_sec` trong `config.toml` ở mục `[mcp_servers.antigravity]`, bằng thời gian chờ cộng thêm khoảng 60 giây (ví dụ chờ 600 giây thì `tool_timeout_sec = 660`), rồi mở lại Codex. Lệnh `agy-mcp-bridge setup codex` in sẵn dòng này theo mức đang chọn; giao diện cũng hiện đúng giá trị cần đặt. Claude Code: biến môi trường `MCP_TOOL_TIMEOUT` tính bằng mili giây, theo tài liệu của Claude Code (chưa kiểm chứng ở đây). Nếu chưa chắc về thời hạn tool của client, giữ mặc định 55 giây.
3. **Skill dặn agent chỉ chờ:** trong lúc task chạy, agent chỉ gọi `antigravity_task_wait`, không đọc file, không chạy git, test hay đọc log, không tự review cùng thay đổi và không viết gì giữa các lần chờ; chỉ khi task kết thúc mới lấy `antigravity_task_output` một lần rồi review. Mỗi lần chờ mà task còn chạy trả kèm ghi chú `next_step` nhắc đúng điều đó ngay lúc agent quyết định bước tiếp theo. Skill cũng cấm agent tự viết script hay client HTTP để gọi bridge: nếu phiên không có các tool `antigravity_*`, agent báo cho bạn (nguyên nhân thường là bridge chưa chạy hoặc client chưa trỏ đúng endpoint) rồi dừng.

Đây là chỉ dẫn, không phải rào chắn kỹ thuật: bridge không ép được mô hình ngừng đọc file trong lúc chờ. Mức tiết kiệm thực tế chưa được đo.

**Tiến độ từng bước (stream-json):** `agy-mcp-bridge probe-stream` trên `agy` 1.4.x cho thấy khi chạy với `--print <prompt> --output-format stream-json`, `agy` phát các sự kiện `init`, `step_update` (nhiều lần, khi đang làm việc) và `result` (kết quả cuối). Cài đặt → "Hiển thị tiến độ từng bước" (mặc định **tắt**, áp dụng cho task mới) cho bridge chạy task theo cách đó: prompt vẫn nằm trên dòng lệnh, chỉ định dạng output đổi.

- Các bước hiện trong chi tiết task ("Các bước Antigravity báo cáo", mới nhất lên đầu), mỗi bước là một dòng tóm tắt tự động kèm dữ liệu gốc (đã lọc secret) mở ra được. Bridge giữ 100 bước gần nhất mỗi task, trong bộ nhớ.
- Các sự kiện `step_update` **không** được ghi vào log stdout của task, nên hàng nghìn bước không làm chạm trần output (256 KiB mặc định); `init` và `result` vẫn được giữ.
- Mỗi bước là bằng chứng "còn sống" thật: chúng được tính là hoạt động cho phần gia hạn bên dưới, và `antigravity_task_wait`/`status` báo thêm "N steps reported" trong dòng `activity` (không gửi nội dung bước cho Codex/Claude để khỏi tốn token).
- **Chưa biết:** nội dung chi tiết bên trong `step_update` (chỉ biết tên các khóa ngoài cùng: `event`, `step_update`), nên phần tóm tắt chọn các trường dễ hiểu (`title`, `type`, `status`, `tool`, `message`, `path`...) nếu có, nếu không thì hiện tên các trường. Cũng chưa kiểm chứng kết quả cuối ở chế độ này có cùng dạng với chế độ JSON (`status`, `response`, `num_turns`). Nếu không giống, task báo lỗi kèm tên các trường của `result` (chỉ tên, không có giá trị) và cách quay về chế độ JSON: tắt tùy chọn này.
- Muốn bridge biết chính xác hình dạng bên trong các sự kiện, chạy lại `agy-mcp-bridge probe-stream` ở bản mới: nó in thêm tên và kiểu của các trường bên trong (không in giá trị).

**Theo dõi mức sử dụng (tab "Sử dụng"):** kết quả JSON của `agy` có các trường `conversation_id`, `duration_seconds`, `num_turns`, `response`, `status` và `usage`. Bridge ghi lại, cho mỗi task đã chạy xong, thời gian chạy, thời gian `agy` báo, số lượt, số bước (khi bật tiến độ) và **mọi giá trị số trong `usage`** (giữ nguyên tên trường, trường lồng nhau nối bằng dấu chấm, ví dụ `cache.read_tokens`). Tab "Sử dụng" hiện tổng task (theo trạng thái), tổng thời gian, usage cộng dồn, biểu đồ 14 ngày (theo múi giờ của trình duyệt), bảng theo model và theo mức suy luận, và các task gần nhất; chi tiết mỗi task có dòng "Usage (agy báo)". Dữ liệu nằm ở `.bridge-state/usage.jsonl` (mỗi task một dòng, giữ qua các lần khởi động lại, tự cắt bớt khi file quá 1 MB, không ghi đường dẫn hay nội dung task) và `stats` trong bản ghi task.

**Mức token (đèn cảnh báo):** Cài đặt → "Mức token" cho đặt hai mức, mặc định **không giới hạn**: mỗi task và mỗi ngày (theo giờ máy của bạn). Danh sách task hiện số token (`total_tokens` agy báo, hoặc input + output nếu không có) và đánh dấu "vượt mức" task nào quá mức; thẻ "Token hôm nay" ở trang Task đổi sang "Vượt mức" khi tổng ngày chạm mức. Đây **chỉ là đèn báo, không phải hạn mức thật và không dừng task**: `agy` không có lệnh nào cho bridge đọc hạn mức, và token của một task chỉ biết khi nó kết thúc. Mức lưu ở `.bridge-state/budget.json`, đổi không cần khởi động lại.

**Nhịp tim khi chờ (thử nghiệm):** nếu client gửi kèm `progressToken` (chuẩn MCP), `antigravity_task_wait` gửi một thông báo tiến độ mỗi 10 giây trong lúc giữ lệnh (nội dung là dòng `activity`). Client nào đặt lại đồng hồ timeout khi nhận tiến độ thì có thể chờ lâu hơn `tool_timeout_sec`; client không làm vậy thì bỏ qua và mọi thứ chạy như cũ. **Chưa biết Codex / Claude Code có đặt lại timeout theo tiến độ hay không**: cách thử là để `tool_timeout_sec` ở mức mặc định (60), đặt thời gian chờ 300 giây trong Cài đặt, giao một task chạy quá 1 phút và xem lệnh chờ có bị báo timeout không. Nếu vẫn timeout thì cần đặt `tool_timeout_sec` như trước. Không có token thì không gửi gì.

**Ghi cấu hình Codex bằng một lệnh:** `agy-mcp-bridge setup codex --apply` hiện đúng thay đổi sẽ ghi vào `~/.codex/config.toml` (hoặc `$CODEX_HOME/config.toml`), hỏi xác nhận (`--yes` để bỏ qua câu hỏi), sao lưu file cũ thành `config.toml.bak-<thời gian>` rồi mới ghi. Nếu mục `[mcp_servers.antigravity]` đã có thì chỉ đổi dòng `tool_timeout_sec` (mặc định **3700** giây, lớn hơn mức chờ tối đa 60 phút của giao diện nên đổi mức chờ không cần chạy lại; đổi bằng `--tool-timeout N`); nếu chưa có thì thêm cả mục. Kiểu viết nó không đọc chắc chắn được (inline table, khóa trong ngoặc kép, hai mục trùng) thì lệnh từ chối và bạn sửa tay. File CRLF giữ nguyên CRLF. Claude Code không bị sửa. Sau khi ghi, mở lại Codex.

**Kết quả "đang chạy" gọn hơn:** khi task còn chạy, `antigravity_task_wait`/`status` chỉ trả `task_id`, `status`, `duration_ms`, `activity` và `next_step` (ngắn). Đường dẫn, số byte, pid... xem ở giao diện web hoặc trong trạng thái đầy đủ khi task đã kết thúc. Mỗi lần Codex hỏi lại vì thế tốn ít token hơn.

- **Đây là mức dùng qua bridge, không phải hạn mức.** `agy` không có lệnh xem hạn mức còn lại và bridge không bịa ra con số đó; xem hạn mức trên tài khoản Antigravity của bạn.
- Bridge **không biết trước** các trường bên trong `usage` (tên trường do `agy` quyết định): nó cộng mọi giá trị số; một vài tên phổ biến (`input_tokens`, `output_tokens`, `total_tokens`...) được dịch nhãn. Task nào kết quả không có `usage` thì ghi nhận là "không có", không phải 0.
- Chỉ thống kê task bắt đầu từ bản có tính năng này trở đi. Số liệu usage không được gửi cho Codex/Claude (không tốn token).

**Biết Antigravity còn hoạt động, và gia hạn thay vì dừng giữa chừng (time out mềm):** ở chế độ `--print --output-format json`, `agy` không in gì cho đến khi xong, nên bridge không thể biết chắc nó đang "suy luận". Bridge chỉ nhìn được những dấu hiệu còn sống: byte mới ở output, và (khi bạn bật tính năng này) việc file log của `agy` được ghi thêm. Cài đặt → "Gia hạn khi Antigravity còn hoạt động" (mặc định **tắt**, áp dụng cho task mới) làm như sau:

- Bridge yêu cầu `agy` ghi log vào `.bridge-state/agy-logs/<task_id>.log` (cờ `--log-file`) và cho `agy` giới hạn tuyệt đối làm print timeout của chính nó, thay vì hạn của task.
- Đến hạn của task (`timeout_seconds`), bridge **không dừng ngay**: nó kiểm tra có hoạt động trong khoảng vừa qua không (byte mới ở output, bước tiến độ nếu bật, hoặc ghi log). Còn thì gia hạn rồi kiểm tra lại sau **1 phút, rồi 5 phút, rồi mỗi 10 phút**. Không có hoạt động trong khoảng đó thì dừng task (trạng thái `timeout`, lý do ghi trong `error`).
- **Giới hạn tuyệt đối** (30 phút đến 8 giờ, mặc định 2 giờ) luôn có hiệu lực: task vẫn còn hoạt động cũng dừng khi tới mức này, để một task treo hay chạy mãi không giữ chỗ vô hạn (chỉ có một task chạy một lúc).
- Chi tiết task trong giao diện hiện "Log của agy cập nhật … (KB)", "Output cuối …", số lần đã gia hạn và lần kiểm tra tiếp theo. `antigravity_task_wait` và `antigravity_task_status` trả thêm một dòng `activity` (ví dụ `last log activity 12s ago; deadline extended 2x while active`) để Codex/Claude không phải tự đọc log.
- **Chưa kiểm chứng:** tôi chưa biết `agy` có ghi log đều đặn trong lúc suy luận hay chỉ ghi lúc bắt đầu và kết thúc. Nếu log không tăng khi `agy` đang chạy thì không có dấu hiệu nào để gia hạn, và task dừng đúng hạn như khi tắt tính năng (không tệ hơn). Cách kiểm tra: bật tính năng, giao một task kéo dài vài chục giây và xem dòng "Log của agy cập nhật…" tăng khi task đang chạy.
- Tắt tính năng thì mọi thứ như cũ: hạn cứng, không có `--log-file`.

**Cấp bậc chờ:** khi Codex/Claude gọi `antigravity_task_wait` mà không chọn số giây, lần chờ đầu của mỗi task dài 1 phút, lần hai 5 phút, từ lần ba là mức tối đa bạn chọn (không bao giờ vượt mức đó; với mặc định 55 giây thì cả ba đều 55 giây). Lệnh chờ kết thúc ngay khi task xong, nên cấp bậc này chủ yếu giúp báo "vẫn đang chạy" đến sớm ở đầu task, không tiết kiệm thêm token. Thời hạn tool của client vẫn phải lớn hơn mức tối đa đó.

**Quyền của Antigravity:** mục Cài đặt → Quyền của Antigravity chọn Antigravity được tự làm đến đâu khi chạy task. Ở chế độ không tương tác, Antigravity tự từ chối việc cần phê duyệt (thấy ở `denied_actions`), nên task sửa file hay chạy lệnh có thể không làm được nếu cài đặt Antigravity chưa cấp quyền. Năm mức, từ thấp đến cao:

| Mức | Cờ truyền cho `agy` | Ý nghĩa |
|---|---|---|
| Mặc định | (không có) | Quyền theo file cài đặt của Antigravity; an toàn nhất, là mặc định |
| Chỉ lập kế hoạch | `--mode plan` | Chỉ lập kế hoạch |
| Tự duyệt sửa file | `--mode accept-edits` | Sửa file được duyệt tự động |
| Tự động | `--mode auto` | Chế độ tự động của Antigravity |
| Toàn quyền | `--dangerously-skip-permissions` | Duyệt mọi yêu cầu, gồm chạy lệnh và truy cập ngoài thư mục dự án |

Chỉ chủ máy đổi được, qua giao diện web; Codex/Claude không có tool nào để đổi. Mức `Tự động` và `Toàn quyền` yêu cầu xác nhận; khi đang bật, giao diện hiện dải cảnh báo, `antigravity_environment` báo `agy_permissions` để Codex/Claude biết và nói với bạn, và chi tiết mỗi task ghi mức quyền đã dùng. Có hiệu lực ngay, không cần khởi động lại. Hạ mức xuống thì áp dụng cả cho task đang xếp hàng; nâng lên thì không (task giữ mức lúc được nhận). Biến `BRIDGE_AGY_PERMISSIONS=default|plan|accept-edits|auto|full` đặt cố định và khóa giao diện (giá trị sai thì dùng `default`). Lựa chọn lưu ở `.bridge-state/permissions.json`.

**Cảnh báo:** danh sách "Workspace được phép" chỉ kiểm tra đường dẫn của task, không phải sandbox; với `Tự động` hay `Toàn quyền`, Antigravity có thể tác động ra ngoài thư mục đó (xóa file, chạy lệnh, dùng thông tin đăng nhập đã lưu). Chỉ bật khi bạn tin tưởng tác vụ, dự án đã được git theo dõi hoặc sao lưu. Các cờ `--mode` chưa được kiểm chứng với `agy` thật qua chế độ `--print`.

## 11. Ghi chú thiết kế và việc chưa làm

- **Nhiều agent:** Phase 1 đã có adapter Antigravity + Codex, chọn agent theo `agents.priority`/`agents.enabled`, worktree song song, kiểm tra `owns`, `agents_list` và `autonomy`. Chưa có daemon mission/orchestrator tự chạy dài hạn, adapter OpenCode/Qoder/Zcode, UI auto-approve riêng hay merge tự động. Xem lộ trình và quyết định trong [docs/MULTI-AGENT-PLAN.md](docs/MULTI-AGENT-PLAN.md).
- **Tiến độ thật của task:** stdin stream-json hiện đã được xác minh ở đường kiểm tra lỗi không gọi AI, và parser lấy terminal `result` theo tài liệu chính thức. Luồng thành công đang được test bằng mock; chưa thực thi AI thật trong đợt hardening. UI hiện hiển thị log snapshot, chưa diễn giải từng `step_update` thành phần trăm tiến độ. Trong lúc task chạy, trang chi tiết có thanh thời gian đã chạy so với giới hạn, thời điểm `agy` ghi output gần nhất, và danh sách thay đổi trong workspace tự làm mới mỗi vài giây khi mở mục "Thay đổi trong workspace" (các tín hiệu này không phụ thuộc định dạng output của `agy`; ở chế độ print/json `agy` chỉ in khi xong nên dòng output có thể trống).
- **`outputSchema` cho tool MCP:** đã thử và bỏ. Schema đầy đủ làm danh sách tool tăng từ khoảng 3,9 KB lên 12,1 KB; nếu client đưa vào ngữ cảnh của agent thì tốn thêm token ở mỗi lượt, trái với mục tiêu giữ chi phí thấp.
- **Đánh giá hành vi của skill:** xem [docs/SKILL-EVAL.md](docs/SKILL-EVAL.md): bộ tình huống và tiêu chí chấm để chạy thủ công với Codex/Claude Code; chưa được chạy tự động.
- **Dọn tiến trình khi crash trên Windows:** xem mục 6; mới có cảnh báo, chưa có bảo đảm.

