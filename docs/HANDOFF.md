# Handoff — dọn cây tiến trình agent và thư mục worktree (B + C)

Cập nhật: 2026-10-26. Nhánh làm việc: `deepseek` (chưa commit, chưa push, chưa release).
Người tiếp theo: đọc mục "Chưa làm" trước khi sửa thêm; mọi mục có cách kiểm lại độc lập.

## 0. Vấn đề gốc (bằng chứng thật, không suy đoán)

Agent CLI không chỉ là một process. `agy` tự khởi động MCP server của nó
(`cmd /c npx -y open-figma-mcp@latest`, `npx -y chrome-devtools-mcp@latest`) với **thư mục làm việc = worktree**
được giao việc. Trên Windows, một process giữ thư mục làm việc đang mở thì thư mục đó **không xóa được, không
đổi tên được**: `git worktree remove`, `rm -rf`, `Remove-Item`, `MoveFile` đều fail (EBUSY / ERROR_ACCESS_DENIED)
dù thư mục trông trống hoàn toàn. Không log nào, không command line nào của process cho thấy điều đó; cách duy
nhất để tìm là đọc CWD của process khác qua PEB
(`OpenProcess(0x0410)` → `NtQueryInformationProcess(class 0)` → PEB+0x20 → +0x38 length, +0x40 buffer) — xem
`test-results/probe-cwd.ps1`.

Chuỗi tiến trình thực đo được từ một lần chạy cầu hình:

```
agy (pid 3300, đã thoát)
  └─ cmd.exe (pid 12848, ĐÃ THOÁT)      ← mắt xích chết
       └─ node.exe  npx -y open-figma-mcp@latest   (pid 29124, còn sống, cwd = worktree)
            └─ cmd.exe /d /s /c open-figma-mcp      (pid 4836, còn sống)
                 └─ node.exe …\open-figma-mcp\server\dist\index.js (pid 15532, còn sống)
```

`ParentProcessId` của Windows là hằng do process ghi khai khi sinh; nó trỏ vào pid chứ không trỏ vào object, nên
khi mắt xích giữa chết thì cả nhánh con **vô hình** với mọi query "con của agent". Ba process đó ghim worktree cho
tới khi bị giết. `taskkill /T` từ gốc 29124 giết cả ba và `rm -rf` thành công ngay sau đó.

## 1. Đã làm (code đã build, đã test đơn vị, đã live-test bằng `agy` thật)

| # | File | Nội dung |
|---|------|----------|
| 1 | `src/isolation/orphans.ts` (mới) | `reapGuard` (PID hợp lệ, không phải bridge, denylist process hệ thống, cửa sổ thời điểm khởi tạo ±5s), `listProcesses` (một query CIM cho toàn bảng), `descendants` (BFS thuần, chống chu cha con), `startTreeWatch` (ghi danh cây tiến trình **trong lúc task chạy**), `reapOwnedTree` (Windows: chỉ giết gốc của từng nhánh còn sống, đối chiếu name+creation để loại PID bị tái sử dụng; POSIX: signal process group của child đã thoát) |
| 2 | `src/isolation/worktree.ts` | `removeWorktree` trả `{removed, reason}` với retry `[0, 200, 600]` ms thay vì nuốt lỗi; `sweepStaleWorktrees` dọn lúc khởi động: chỉ thư mục **rỗng** mang tên task-id, bỏ lại thư mục còn file, bỏ qua task `queued`/`running`, đọc cả hai shape record |
| 3 | `src/tasks/manager.ts` | Nối watcher vào vòng đời task (`watchTree` seam, stop khi child đóng, `observed` đưa vào reap); `task.cleanup` là `TreeReport`; giải phóng chạy **sau** khi trạng thái cuối đã công bố và được patch vào record bằng `persist(task, held)`; `REAP_BUDGET_MS = 6000` với timer `unref`; `persist` retry rename khi `EPERM/EACCES/EBUSY` (Windows từ chối rename đè lên record mà UI/client đang mở để đọc); đường launch fail ghi rõ reason khi không xóa được worktree |
| 4 | `src/runtime.ts` | `watchTree: startTreeWatch` (manager không tự chọn cơ chế OS); gọi `sweepStaleWorktrees` sau `recoverExecutionLock` và log từng thư mục xóa/giữ; hai dòng `limitations` mô tả đúng hành vi mới |
| 5 | `tests/isolation-orphans.test.ts`, `tests/isolation-worktree.test.ts`, `tests/agents.test.ts`, `tests/hardening-output.test.ts` | Guard rules; giết đúng gốc nhánh; subtree dưới shell đã chết vẫn được giải phóng; PID tái sử dụng không biến cây lạ thành cây của mình; `descendants`; watch poll/accumulate/stop; worktree thật bằng git thật; busy simulation; sweep; thứ tự "status trước, cleanup sau" và request/stats không bị null sau patch; bound snapshot theo `duration_ms` thay vì hằng số 3 |

Hành vi không đổi, cố ý giữ: bind `127.0.0.1`, kiểm tra Host/Origin, **không** xác thực token, không cờ bypass
permission, không tự merge worktree, hard-deny deploy/publish/xóa dữ liệu/push nhánh bảo vệ/đọc credential/thay
đổi hệ thống ngoài workspace, và **trạng thái cuối chỉ xuất bản sau khi `inspectScope` xong**.

## 2. Chưa làm (mỗi dòng là một việc, kèm cách kiểm)

1. **Nguyên nhân gốc vẫn còn**: `open-figma-mcp` và `chrome-devtools-mcp` vẫn bật **toàn cục** trong
   `~/.gemini/config/mcp_config.json` (thư mục cấu hình của user chạy bridge). bridge chỉ dọn *sau khi* agent thoát, không ngăn chúng khởi
   động. Chưa tắt bằng `agy mcp disable open-figma-mcp` (lựa chọn A) vì lệnh đó đổi cấu hình cá nhân của người
   dùng và `agy mcp` chỉ có tác dụng global — **không** có `--config-dir`/`--mcp-config` per-task (đã kiểm
   `agy help` ở phiên trước). Hệ quả còn lại: một phiên `agy` chạy *ngoài* bridge vẫn để lại cây ghim thư mục.
2. **Không có Windows Job Object** (lựa chọn D). Bridge bị giết đột ngột (`taskkill` chính nó, SIGKILL, OS crash,
   mất điện) giữa lúc task chạy thì không có lần giải phóng nào; worktree bị ghim cho tới khi process giữ nó chết.
   `KILL_ON_JOB_CLOSE` mới là bảo đảm thật. Node không có API job, cần native addon hoặc P/Invoke `CreateJobObject`
   + `AssignProcessToJobObject` lúc spawn — chưa làm, chưa đánh giá chi phí/rủi ro.
3. **Lỗ hổng của watcher** (có ghi trong mã, chưa bịt): process sinh ra **và** mắt xích cha của nó chết *giữa hai
   nhịp poll* sẽ không bao giờ vào `observed`, nên không thành gốc lúc reap. Nhịp hiện tại `WATCH_DELAYS_MS =
   [500, 1000, 2000, 4000, 10000]` ms (dày lúc `agy` boot MCP server, thưa dần về sau); chưa có bằng chứng cho CLI
   khác (codex, OpenCode…) với mô hình spawn khác — nhịp là suy đoán từ `agy` 1.4.7.
4. **PID reuse mới chỉ giảm rủi ro, chưa loại bỏ**: cửa sổ ±5s + denylist ảnh hệ thống + đối chiếu name/creation
   giữa record và bảng lúc reap + chạy ngay sau khi child exit. Chưa so image path/handle. Trường hợp xấu nhất vẫn
   là "PID được cấp cho process lạ trùng cửa sổ" — cần quyết định: siết thêm hay chấp nhận và tài liệu hóa.
5. **Chi phí poll đã đo một lần, chưa tuning và không tắt được**: trên máy dev ngày 2026-10-26, một nhịp
   `Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate` (toàn bảng, ~337 dòng) tốn
   **555 ms**; bản lọc `-Filter "ParentProcessId=X"` tốn 172 ms nhưng chỉ tìm được con trực tiếp — không đủ cho mục
   0. Thêm `CommandLine` làm gần gấp đôi chi phí nên bảng không lấy cột đó. Dùng toàn bảng vì một bảng trả được cả
   cây và các cha đã chết. Với nhịp hiện tại, task 300 s ≈ 40 nhịp ≈ 6% chu kỳ làm việc của một `powershell.exe`
   riêng; số đo lấy lúc máy rảnh, chưa đo lúc tải cao hoặc máy chậm, và **chưa có config để tắt watcher hay đổi nhịp**.
6. **Đường POSIX chỉ được test bằng fake**: `group_alive`/`signal_group` được inject trong unit test; chưa chạy
   live E2E trên Linux cho phần release (CI matrix chạy unit test trên Ubuntu).
7. **Báo cáo giải phóng không có ở UI**: `task.cleanup` tồn tại trong `antigravity_task_status` và
   `.bridge-state/tasks/<id>.json`, nhưng `src/ui` không render (grep `cleanup` trong `src/ui` = 0 kết quả). Nếu
   muốn hiển thị, làm chung với gate 6 trong `docs/MULTI-AGENT-PLAN.md` (UI hiển thị worktree/branch).
8. **`cleanup` có thể mất**: reap chạy nền sau khi lane đã nhả; nếu server thoát trong ~6 s sau khi agent exit thì
   bản vá record không kịp ghi (chưa có flush-on-shutdown cho reap đang chờ).
9. **Sweep chỉ xóa thư mục rỗng**: worktree còn file mà không ai review thì còn mãi; branch `bridge/*` không bao giờ
   bị xóa tự động (chính sách "không tự merge/xóa"). Chưa có TTL, chưa có nút/CLI dọn, và **`git worktree prune`
   chưa từng được gọi** → sau khi xóa tay/`sweep`, bản ghi admin trong `<toplevel>/.git/worktrees/*` vẫn còn và
   `git worktree list` báo prunable.
10. **`removeWorktree` thực tế chỉ chạy ở một nhánh hẹp** (launch chưa kịp spawn). Worktree của task hoàn tất được
       giữ lại có chủ đích, nên đường EBUSY của nó chỉ được chứng minh bằng test mô phỏng, chưa bằng production.
11. **Chưa commit/push/release**; chưa xin xác nhận của người dùng cho lần thay đổi này (lần chấp nhận trước chỉ
       covering thay đổi đã merge). Scripts kiểm chứng đang ở `test-results/` và **bị gitignore**:
       `verify-reap.mjs` + `probe-cwd.ps1` là đường tái hiện lỗi (đừng xóa); `trace-ancestry.ps1`,
       `list-test-runners.ps1`, `inspect-child.ps1` chỉ là trợ giúp một lần của phiên này — `inspect-child.ps1` còn
       chưa chạy lần nào. Cần quyết: nâng thành `scripts/live-reap.ts` có gate, hay xóa sau khi xong.

## 3. Bằng chứng

Unit (`npm test` = build + `node dist/scripts/run-tests.js`, 210 test):

- Sequential (`node --test --test-concurrency=1 dist/tests/*.test.js`): **207 pass, 0 fail, 3 skipped**, 164,9 s. Đã
  chạy lại lần hai sau bản sửa cuối (nhịp poll thưa hơn) và vẫn 207/0/3 — hai lần độc lập, cùng số.
- Parallel (`npm test`) trên Windows, chạy liên tiếp 3 lần: `206/1 fail`, `205/2 fail`, `207/0 fail`. Đứng một mình, từng test lỗi đều xanh (progress 9/9 hai lần, bridge.test 27/27).
- Nhà lỗi luôn là nhóm nhạy cảm timing: `progress` (…signal counts as activity), `http` (startup warns about the local trust model), `soft-timeout` (last activity Ns ago), `hardening-output` (số snapshot). Chúng flake theo tải của runner, không theo code; ba phiên liên tiếp cho ba test khác nhau. Đứng riêng, `progress.test.js` xanh 3/3 lần (9 pass), `bridge.test.js` 27/27. Không nới assertion để né. **Đã chốt ngày 2026-10-27**: `scripts/run-tests.ts` truyền `--test-concurrency=1`, nên từ nay `npm test` — và CI — chạy tuần tự; thời gian trên máy dev Windows là ~158 s thay vì ~47 s. Hai gạch đầu dòng trên là số liệu lịch sử của chế độ song song, không còn tái hiện được bằng `npm test`. Xác nhận sau khi đổi: `npm test` cho **207 pass, 0 fail, 3 skipped** trong 161,7 s (ngày 2026-10-27). Cờ `--test-concurrency` chỉ tồn tại từ Node 20.10 / 18.19 / 21.0 trở đi; CI đặt `node: [20, 22]` nên luôn nhận cờ, còn dev dùng Node 20.0–20.9 sẽ gặp `bad option: --test-concurrency` — cố ý không feature-detect trong script và không nâng `engines.node`, vì đây chỉ là đường chạy test của người phát triển, không phải đường chạy của sản phẩm đã publish.
- Bộ mới viết xanh tuyệt đối khi chạy riêng: `tests/isolation-orphans.test.js` 9/9, `tests/isolation-worktree.test.js` và `tests/agents.test.js` chạy kèm (`23 pass, 0 fail`).

Live, `agy` 1.4.7 thật, MCP client `streamable-http`, scratch trong `%TEMP%` (không đụng repo), hai lần:

```
sweep_log        : Removed a stale empty worktree directory: …\worktrees\a52a2e42-…
                 : Kept worktree directory …\worktrees\0cfa0399-… : it still holds files for review
task             : completed, pid 30288, scope {checked: true, changed: 1, out_of_scope: []}
cleanup          : {checked: true, reaped: [30768, 24304], skipped: [], tracked: 14}   (lần 1)
cleanup          : {checked: true, reaped: [33960, 30004, …], skipped: [], tracked: 13} (lần 2, nhịp đã thưa hơn)
release log      : [bridge] Task tree release: 2 process tree(s) reaped, 0 left running
cwd probe        : HITS 0                     ← không còn process nào giữ cwd trong scratch
note.txt         : REAP_OK ; original workspace: [.git, a.txt]  ← worktree không rò sang repo gốc
shutdown         : POST /ui/api/shutdown → 202, exit code 0
scratch cleanup  : cả hai cây %TEMP% "removed" (không cần force)
```

Báo cáo đầy đủ: `test-results/reap-report.json` (gitignored). Chạy lại:

```bash
npm run build && node test-results/verify-reap.mjs   # cần agy đã đăng nhập; tạo scratch trong %TEMP%
powershell -NoProfile -ExecutionPolicy Bypass -File test-results/probe-cwd.ps1 -Match bridge-reap
```

Lưu ý: run **trước** bản sửa cho thấy `HITS 3` đúng với chuỗi tiến trình ở mục 0 (`cleanup.reaped` chỉ có 1 PID)
— đó là lý do thiết kế chuyển từ "query con trực tiếp lúc exit" sang "ghi cây trong lúc chạy + một bảng tiến trình
lúc reap".

## 4. Cách làm việc cho người tiếp theo

- Không tự nới quyền CLI khi gặp permission denial; không thêm cờ bypass; không mở bridge ra LAN/proxy công khai.
- Bridge cố ý không có token: chỉ dùng trên máy do chủ máy kiểm soát; bất kỳ tiến trình cục bộ cùng user đều điều
  khiển được agent.
- Trước khi đụng `manager.ts`: giữ nguyên thứ tự `flushOutput → parseResult → inspectScope → release owns lock →
  publish status → persist → appendUsage → release lane → finish → startNext`. Test
  `a worktree task never reports a final status before its owns scope is attached`
  và `a finished task records the agent process trees it released without delaying its status`
  (`tests/agents.test.ts`) chèn cả hai chiều của ràng buộc đó.
- Test không được phép gọi `powershell.exe`: `TaskManager` chỉ dùng `runtime.watchTree` khi được nối, mặc định inert.
  `createRuntime` (`src/runtime.ts`) là nơi nối `startTreeWatch`.
- Không xóa `test-results/` trước khi mục 2.11 có quyết định; các file đó là cách tái hiện lỗi.
