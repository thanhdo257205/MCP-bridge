# Handoff — dọn cây tiến trình agent và thư mục worktree

Cập nhật: 2026-10-27. Nhánh làm việc: `deepseek`. Đợt 1 (mục 1.1–1.5) đã merge vào `main` qua PR #28/#29 và đã phát
hành `0.1.20`; **đợt 2 (mục 1.6–1.13) còn nguyên trong working tree — chưa commit, chưa push, chưa release.**
Người tiếp theo: đọc mục "Chưa làm" trước khi sửa thêm; mọi mục có cách kiểm lại độc lập.

Mục 1 ghi hai đợt. Đợt 2 (hôm nay) là phần B của `docs/HANDOFF.md` cũ: bịt các lỗ hổng đã tự ghi nhận ở
mục "Chưa làm" — pid bị cấp lại giữa lúc giết, nhịp poll không chỉnh được, verdict mất khi shutdown, báo cáo
không có ở UI, bản ghi admin worktree không bao giờ được prune, và nhánh group-kill POSIX chưa từng gặp một
process group thật.

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

### Đợt 1 — 2026-10-26: ghi cây lúc chạy + release sau khi công bố trạng thái

| # | File | Nội dung |
|---|------|----------|
| 1 | `src/isolation/orphans.ts` (mới) | `reapGuard` (PID hợp lệ, không phải bridge, denylist process hệ thống, cửa sổ thời điểm khởi tạo ±5s), `listProcesses` (một query CIM cho toàn bảng), `descendants` (BFS thuần, chống chu cha con), `startTreeWatch` (ghi danh cây tiến trình **trong lúc task chạy**), `reapOwnedTree` (Windows: chỉ giết gốc của từng nhánh còn sống; POSIX: signal process group của child đã thoát) |
| 2 | `src/isolation/worktree.ts` | `removeWorktree` trả `{removed, reason}` với retry `[0, 200, 600]` ms thay vì nuốt lỗi; `sweepStaleWorktrees` dọn lúc khởi động: chỉ thư mục **rỗng** mang tên task-id, bỏ lại thư mục còn file, bỏ qua task `queued`/`running`, đọc cả hai shape record |
| 3 | `src/tasks/manager.ts` | Nối watcher vào vòng đời task (`watchTree` seam, `observed` đưa vào reap); `task.cleanup` là `TreeReport`; giải phóng chạy **sau** khi trạng thái cuối đã công bố và được patch vào record bằng `persist(task, held)`; `REAP_BUDGET_MS = 6000` với timer `unref`; `persist` retry rename khi `EPERM/EACCES/EBUSY` (Windows từ chối rename đè lên record mà UI/client đang mở để đọc); đường launch fail ghi rõ reason khi không xóa được worktree |
| 4 | `src/runtime.ts` | `watchTree: startTreeWatch` (manager không tự chọn cơ chế OS); gọi `sweepStaleWorktrees` sau `recoverExecutionLock` và log từng thư mục xóa/giữ; hai dòng `limitations` mô tả đúng hành vi mới |
| 5 | `tests/isolation-orphans.test.ts`, `tests/isolation-worktree.test.ts`, `tests/agents.test.ts`, `tests/hardening-output.test.ts` | Guard rules; giết đúng gốc nhánh; subtree dưới shell đã chết vẫn được giải phóng; PID tái sử dụng không biến cây lạ thành cây của mình; `descendants`; watch poll/accumulate/stop; worktree thật bằng git thật; busy simulation; sweep; thứ tự "status trước, cleanup sau" và request/stats không bị null sau patch; bound snapshot theo `duration_ms` thay vì hằng số 3 |

### Đợt 2 — 2026-10-27: bịt các lỗ tự ghi nhận (B2.4, B2.5, B2.6, B2.7, B2.8, B2.9) + A4

| # | File | Nội dung |
|---|------|----------|
| 6 | `src/isolation/orphans.ts` | `listProcessesById(pids)` (một query CIM **lọc theo đúng các pid sắp giết**, mọi pid được kiểm tra số học trước khi ghép vào chuỗi WQL) + `ReapOptions.verify`: **trước khi** `taskkill`, mỗi gốc nhánh được đọc lại và đối chiếu name/creation với bảng mới; pid đã bị cấp cho process khác thì bỏ và ghi guard `pid was reissued to another process after the tree query`; query phụ lỗi thì quyết định cũ vẫn đứng (catch, không chặn release). `TreeWatch.stop()` trả `Promise<ProcessInfo[]>` và lấy **một nhịp cuối** để không bỏ sót shell vừa sinh con sát lúc agent thoát |
| 7 | `src/isolation/worktree.ts` | Sweep mặc định đi **git trước**: `git worktree remove --force` (xóa cả bản ghi admin), chỉ fallback `rmdir` khi repo không còn dùng được; `SweepReport.prunable` = danh sách repo cần dọn bản ghi; một lượt đọc **record task** (`TASK_RECORD`) để bắt worktree đã biến mất mà không qua git (thư mục xóa tay thì `readdir` cha không còn thấy); `pruneWorktrees(repo)` mới: `git worktree list --porcelain` → `git worktree prune -v --expire=now` → đếm bản ghi thực sự biến mất |
| 8 | `src/tasks/manager.ts` | `task.worktree_toplevel` (sweep/prune cần repo gốc); nhịp đọc cuối của watcher chuyển **vào chain giải phóng** nên một query tiến trình kẹt không giữ lane mà task kế tiếp đang chờ; `pendingRelease` + `shutdown()` chờ phần đang chạy với trần `REAP_BUDGET_MS + 2000` (timer `unref`) để verdict cuối không mất khi dừng bridge lịch sự |
| 9 | `src/config.ts`, `config/workspaces.example.json`, `src/runtime.ts` | `tree_watch: {enabled?, delays_ms?}` (int 100–60000 ms, 1–20 nhịp, `.strict()` nên khóa các khóa lạ); mặc định = `WATCH_DELAYS_MS`; `enabled: false` in một dòng WARNING khi khởi động (release chỉ còn thấy cây treo dưới agent lúc nó thoát — đúng trường hợp đã ghim worktree ở mục 0); runtime truyền `delays` vào `startTreeWatch` và gọi `pruneWorktrees` cho từng repo sweep báo prunable, log số bản ghi đã dọn hoặc reason không dọn được |
| 10 | `ui/app.js` | `cleanupBody(task)` render `task.cleanup` cạnh dòng scope: `Không kiểm tra được cây tiến trình agent: …` / `Tiến trình agent để lại: đã giải phóng N cây (pid) · X nhánh vẫn chạy: pid — guard · đã ghi danh N tiến trình · đã gửi tín hiệu tới cả nhóm tiến trình`. Absent khi task chưa chạy xong, nên không có dòng không phải là lỗi dọn. Đã xem bằng Chrome DevTools với một task `agy` thật (mục 3) |
| 11 | `tests/hardening-process.test.ts` | Nhánh POSIX giờ có **process thật**: `leaveASurvivor()` sinh agent `detached` spawn một survivor rồi thoát; ba test (skip trên win32) chứng minh `group_signalled`, survivor tuân SIGTERM chết ngay, survivor lờ SIGTERM chết sau `TERMINATION_GRACE_MS`, và group rỗng thì không hề có tín hiệu |
| 12 | `tests/isolation-orphans.test.ts`, `tests/isolation-worktree.test.ts`, `tests/config.test.ts`, `tests/bridge.test.ts`, `tests/http.test.ts`, `tests/package.test.ts` | pid cấp lại giữa query và kill không bao giờ bị signal (kèm: verify trả `[]` → không giết; verify ném lỗi → vẫn giết theo quyết định cũ); sweep xóa bản ghi admin cùng thư mục; repo có thư mục bay không qua git được xếp hàng prune; cadence mặc định là của mã, giá trị sai bị **từ chối** chứ không âm thầm tắt reaper, file example phải parse được; shutdown không bỏ mất verdict đang chạy; `/ui/api/tasks/<id>` trả đúng bản `cleanup` cho UI; `docs/HANDOFF.md` không nằm trong package đã publish |
| 13 | `package.json`, `README.md` | `files` loại `docs/HANDOFF.md` (ghi chú nội bộ, không phải tài liệu cho người cài package); §6 README viết lại ba đoạn: reaper + trường `cleanup` + dòng UI, kiểm tra lại pid trước khi giết, `tree_watch` (nhịp/tắt), và sweep + `git worktree prune --expire=now` kèm blast radius và đường thoát `git worktree repair` |

Hành vi không đổi, cố ý giữ: bind `127.0.0.1`, kiểm tra Host/Origin, **không** xác thực token, không cờ bypass
permission, không tự merge worktree, hard-deny deploy/publish/xóa dữ liệu/push nhánh bảo vệ/đọc credential/thay
đổi hệ thống ngoài workspace, và **trạng thái cuối chỉ xuất bản sau khi `inspectScope` xong**.

## 2. Chưa làm (mỗi dòng là một việc, kèm cách kiểm)

1. **`agy mcp disable` KHÔNG phải là công tắc tắt** (đo ngày 2026-10-27). Entry `open-figma-mcp` đã được
   `agy mcp disable` ghi thành `disabled: true` trong `~/.gemini/config/mcp_config.json`, `agy mcp list` báo
   `disabled`, nhưng agent vẫn sinh đúng chuỗi `cmd /c npx -y open-figma-mcp@latest` trong lúc task chạy — CLI bỏ
   qua cờ này khi khởi động MCP server. Đường duy nhất có tác dụng là **`agy mcp remove`**: sau khi remove, probe
   theo cwd không còn thấy process nào của nó nữa. Hệ quả thật đã mất: **`open-figma-mcp` chính là thủ phạm ghim
   worktree** (nó không bao giờ tự thoát), còn `chrome-devtools` tuy vẫn bật nhưng tự kết thúc trước khi agent
   xong nên không để lại gì — `cleanup.reaped` của task live bây giờ là `[]` và probe cwd trả `HITS 0` **ngay lúc
   agent thoát**, tức reaper không còn phải giết gì.
   Còn mở: `chrome-devtools` vẫn tồn tại ở **hai** nơi — `~/.gemini/config/mcp_config.json` (đã `disabled: true`,
   bị CLI phớt lờ) và `~/.gemini/antigravity-ide/mcp_config.json` (không có key `disabled`). Muốn nó không bật nữa
   thì phải remove, và file thứ hai là cấu hình của **Antigravity IDE** chứ không phải CLI — cần chủ máy quyết.
   `figma` và `unityMCP` là `http`, không sinh process local nên giữ nguyên. Bản ghi nguyên trạng trước khi động
   vào cấu hình: `test-results/mcp_config.before-agy-disable.json`; hoàn nguyên bằng
   `agy mcp add open-figma-mcp --command cmd --args "/c" "npx" "-y" "open-figma-mcp@latest"` (hoặc copy lại file).
   Cách kiểm: `node test-results/who-pins.mjs` (in `pinners_during_run` / `pinners_at_exit` / `reaped_named`, lọc
   theo cwd nên không lẫn process của công cụ khác).
   **Dù vậy reaper của bridge vẫn phải ở lại**: `remove` chỉ sửa được máy đã đồng ý; `agy` bản khác, CLI khác
   (codex, OpenCode…) hoặc chính người dùng bật lại MCP server sẽ tái hiện đúng tình trạng mục 0 — và `tracked: 8`
   của run vừa rồi chứng minh vẫn còn cả chuỗi `chrome-devtools` để ghi danh trong lúc task chạy.
2. **Không có Windows Job Object** (lựa chọn D). Bridge bị giết đột ngột (`taskkill` chính nó, SIGKILL, OS crash,
   mất điện) giữa lúc task chạy thì không có lần giải phóng nào; worktree bị ghim cho tới khi process giữ nó chết.
   `KILL_ON_JOB_CLOSE` mới là bảo đảm thật. Node không có API job, cần native addon hoặc P/Invoke `CreateJobObject`
   + `AssignProcessToJobObject` lúc spawn — chưa làm, chưa đánh giá chi phí/rủi ro.
3. **Lỗ hổng của watcher mới bị hẹp lại, chưa bịt kín**: một process sinh ra **và** mất mắt xích cha *giữa hai nhịp
   poll* vẫn không bao giờ vào `observed`, nên không thành gốc lúc reap. Đợt này thêm một nhịp chốt ở `stop()` nên
   đoạn "sát lúc agent thoát" đã được phủ; đoạn giữa hai nhịp vẫn phụ thuộc `WATCH_DELAYS_MS =
   [500, 1000, 2000, 4000, 10000]` ms — dày lúc `agy` boot MCP server, thưa dần về sau. Nhịp đó vẫn là **suy đoán
   từ `agy` 1.4.7**; đã chỉnh được qua `tree_watch.delays_ms` nhưng chưa đo để chọn cho CLI khác (codex, OpenCode…).
   Cách kiểm: chạy `test-results/verify-reap.mjs` với một CLI cụ thể rồi xem `cleanup.tracked` có bắt được cả cây.
4. **PID reuse mới chỉ giảm rủi ro, chưa loại bỏ**: cửa sổ ±5s + denylist ảnh hệ thống + đối chiếu name/creation
   giữa record và bảng lúc reap + **đọc lại đúng các pid sắp giết** ngay trước `taskkill`. Chưa so image path hay
   mở handle để xác nhận. Trường hợp xấu nhất còn lại: pid được cấp cho process lạ **trùng cả tên và thời điểm khởi
   tạo** trong cửa sổ ±5s. Cần quyết định: siết thêm (so `ExecutablePath`) hay chấp nhận và tài liệu hóa.
5. **Chi phí poll đã đo một lần, chưa tuning**: một nhịp `Get-CimInstance Win32_Process -Property
   ProcessId,ParentProcessId,Name,CreationDate` (toàn bảng, ~337 dòng) tốn **555 ms** trên máy dev ngày
   2026-10-26; bản `-Filter "ParentProcessId=X"` tốn 172 ms nhưng chỉ tìm được con trực tiếp — không đủ cho mục 0.
   Thêm `CommandLine` làm gần gấp đôi chi phí nên bảng không lấy cột đó. Nay đã có `tree_watch` để đổi nhịp hoặc tắt,
   nhưng số đo vẫn lấy lúc máy rảnh: chưa đo lúc tải cao hoặc máy chậm, và `tracked` chỉ nói số tiến trình ghi danh
   chứ không nói số nhịp đã tốn.
6. **POSIX mới có coverage process-thật ở tầng unit, chưa có E2E CLI thật**: ba test trong
   `tests/hardening-process.test.ts` dựng survivor bằng `sh` thật nên vòng `SIGTERM → grace → SIGKILL` đã chạy thật
   (xem mục 3), nhưng chưa có một phiên Linux chạy `agy`/`codex` thật qua bridge. `codex-cli 0.163.0` trên máy này
   **đã mất tài khoản** nên chưa tự làm được; cần `codex login` rồi chạy `node test-results/trial-handoff.mjs <mcp-url> <workspace> codex`.
7. **Worktree hoàn tất vẫn nằm lại vô hạn**: sweep chỉ xóa thư mục **rỗng**; nội dung chờ review không bao giờ bị tự
   xóa (đúng chính sách), nên worktree có file mà không ai review thì còn mãi, và branch `bridge/*` không bao giờ bị
   xóa tự động. Chưa có TTL, chưa có nút/CLI "dọn worktree đã merge".
8. **`pruneWorktrees` có blast radius toàn repo**: `git worktree prune` không chọn từng bản ghi — nó dọn **mọi** bản
   ghi admin trỏ tới thư mục đã biến mất của repo đó, kể cả worktree do người dùng tạo tay ngoài bridge (và ngược
   lại, worktree bridge tạo tay ở chỗ khác sẽ bị dọn khi thư mục biến mất). Đã ghi rõ trong README kèm đường thoát
   `git worktree repair`; chưa cân nhắc thu hẹp (chỉ prune khi đường dẫn nằm trong `.bridge-state/worktrees/`, hoặc
   xin xác nhận lúc khởi động).
9. **`removeWorktree` thực tế chỉ chạy ở một nhánh hẹp** (launch chưa kịp spawn). Worktree của task hoàn tất được
   giữ lại có chủ đích, nên đường EBUSY của nó chỉ được chứng minh bằng test mô phỏng, chưa bằng production.
10. **Chưa commit/push/release đợt 2**; chưa xin xác nhận của người dùng cho lần thay đổi này (lần chấp nhận trước chỉ
    covering thay đổi đã merge). Scripts kiểm chứng đang ở `test-results/` và **bị gitignore**:
    `verify-reap.mjs` + `probe-cwd.ps1` là đường tái hiện lỗi (đừng xóa), `ui-cleanup-check.mjs` là đường dựng một
    bridge sống để xem dòng `cleanup` trong UI, `trial-handoff.mjs` + `trial-readback.mjs` là hai phiên trao đổi
    agent-qua-agent; `trace-ancestry.ps1`, `diag-evict.mjs`, `diag-gate.mjs` chỉ là trợ giúp một lần.
    Cần quyết: nâng `verify-reap.mjs` thành `scripts/live-reap.ts` có gate, hay xóa sau khi xong.

## 3. Bằng chứng

Unit Windows (`npm test` = build + `node dist/scripts/run-tests.js` với `--test-concurrency=1`, Node 24.15.0),
ngày 2026-10-27 sau bản sửa cuối: **220 test, 214 pass, 0 fail, 6 skipped**, 234,1 s, exit 0. Sáu dòng `# SKIP` là
năm test tự khai `{skip: process.platform === 'win32'}` trong `tests/hardening-process.test.ts` (hai test cũ
`terminateOwned` + ba test process-thật mới ở mục 1.11) và `cli: --open hands the UI address …` vốn chỉ chạy trên
Linux. So với đợt 1 (211 test / 3 skipped): số test tăng đúng 9 = chín test mới của đợt 2, số skipped tăng đúng 3 =
ba test POSIX mới.

Unit Linux (WSL Ubuntu, Node **20.20.2**, `node --test --test-concurrency=1 dist/tests/*.test.js`, `dist/` build
từ Windows chạy thẳng qua `/mnt/c`), cùng ngày: **220 test, 219 pass, 0 fail, 1 skipped**, 195,0 s, exit 0. Test bị
bỏ là `Windows .cmd shims resolve to a local Node entry without a shell` (đúng như mong đợi). **B2.6 đã có verdict**:
sáu test nhóm POSIX signal chạy thật trên Linux, trong đó ba test process-thật mới —
`a POSIX release signals the exited agent group and a survivor that obeys SIGTERM goes quietly`,
`a POSIX release escalates the group it signalled when a member ignores SIGTERM`,
`an exited agent whose group is already empty is left completely alone` — đều `ok`, nên vòng
`SIGTERM → TERMINATION_GRACE_MS → SIGKILL` không còn là nhánh chỉ được inject trong unit test.
Hai nền không so sánh bằng hiệu số: trên Windows `6 skipped` = năm test nhóm POSIX signal +
`cli: --open hands the UI address to the system browser opener (Linux only: uses a stub xdg-open)`; trên Linux
`1 skipped` = `Windows .cmd shims resolve to a local Node entry without a shell`.

Bằng chứng hồi quy (mỗi fix được chứng minh bằng cách **tháo fix** rồi xem test đỏ — không nới assertion để né):

| Mutation | Test | Kết quả |
|---|---|---|
| Bỏ khối `verify` trong `reapOwnedTree` | `a pid reissued between the tree query and the kill is never signalled` | **Đỏ**: killed `[3001, 3002, 3003]` thay vì `[3002, 3003]` (pid 3001 đã bị cấp lại vẫn bị giết) |
| Bỏ `await Promise.race([...])` trong `shutdown()` | `shutdown waits for a tree release still in flight so its verdict is not lost` | **Đỏ**: `AssertionError: shutdown ran the release out instead of dropping it — false !== true` |
| Bỏ nhịp đọc cuối trong `TreeWatch.stop()` | watch poll/accumulate/stop | **Đỏ**: `observed` thiếu pid `9911` sinh ra sau nhịp poll cuối |
| Thêm record-driven pass cho sweep | `a repository whose directory went without git is queued for pruning` | Đỏ **một cách tự nhiên** ở lần chạy đầu (`prunable: []`) vì thư mục xóa tay không còn trong `readdir` cha — đó là lý do có lượt đọc record |
| `pruneWorktrees` đếm từ `-v` | `the sweep drops the git admin record with the directory it removes` | Đỏ: `pruned: 0` hai lần — thứ nhất vì git mặc định chỉ prune bản ghi cũ hơn 3 tháng (phải `--expire=now`), thứ hai vì `prune -v` in ra **stderr** còn helper `git()` chỉ nhận stdout |

Live với **code đợt 2**, `agy` 1.4.7 thật, MCP client `streamable-http`, scratch trong `%TEMP%` (không đụng repo),
ngày 2026-10-27 (báo cáo `test-results/reap-report.json`, gitignored):

```
sweep_log        : Removed a stale empty worktree directory: …\worktrees\f273eaff-…
                 : Kept worktree directory …\worktrees\be16f242-… : it still holds files for review
task             : completed, pid 24836, scope {checked: true, changed: 1, out_of_scope: [], truncated: false}
cleanup          : {checked: true, reaped: [28256, 29124, 23416], skipped: [], tracked: 15}
release log      : [bridge] Task tree release: 3 process tree(s) reaped, 0 left running
cwd probe        : HITS 0                     ← không còn process nào giữ cwd trong scratch
note.txt         : REAP_OK ; original workspace: [.git, a.txt]  ← worktree không rò sang repo gốc
scratch cleanup  : cả home và repo "removed" (không cần force), server exit 0 sau POST /ui/api/shutdown
```

Ba điều đáng ghi từ run này: `skipped` rỗng nên phép thử lại pid trước khi giết không đổi quyết định trong đường
thường; `tracked: 15` lớn hơn nhiều số gốc bị giết (3) nên phần ghi-danh-cây vẫn đang làm việc, không phải fallback;
và `prunable` rỗng là **đúng** chứ chưa phải bằng chứng — worktree của task hoàn tất được giữ có chủ đích nên đường
`git worktree prune` chỉ mới được chứng minh bằng test với git thật (`the sweep drops the git admin record with the
directory it removes`), chưa chạy trên production.

Thử nghiệm nguyên nhân gốc (2026-10-27, `who-pins.mjs`, cùng máy, `agy` 1.4.7), ba trạng thái của
`~/.gemini/config/mcp_config.json`, số liệu là process có **cwd nằm trong worktree scratch**:

| Cấu hình | `pinners_during_run` | `pinners_at_exit` | `cleanup` |
|---|---|---|---|
| cả hai `enabled` (trạng thái gốc) | `open-figma-mcp` + `chrome-devtools` (9 process) | `HITS 3` — toàn chuỗi open-figma | `reaped [28256, 29124, 23416]`, `tracked 15` |
| cả hai `disabled: true` (sau `agy mcp disable`) | vẫn đủ hai chuỗi → **cờ bị CLI bỏ qua** | `HITS 3` — vẫn chuỗi open-figma | `reaped [28876, 31172]`, `tracked 10` |
| `open-figma-mcp` đã `agy mcp remove` | chỉ còn `chrome-devtools` (5 process, tự thoát trước khi agent xong) | **`HITS 0`** | **`reaped []`**, `tracked 8` |

Đọc bảng: thứ ghim worktree là `open-figma-mcp` (không bao giờ tự thoát), `disable` không có tác dụng, và
`remove` thì có — bridge không còn phải giết gì trên máy này nữa.

UI bằng **trình duyệt thật** (Chrome DevTools, một bridge **riêng** dựng bằng `test-results/ui-cleanup-check.mjs`,
task `2f8a65f8`, `cleanup={reaped:[35600,19716], skipped:[], tracked:10}`): `/ui/` render đúng một callout trung tính
ngay dưới dòng scope — `Tiến trình agent để lại: đã giải phóng 2 cây tiến trình (35600, 19716) ·
đã ghi danh 10 tiến trình trong lúc agent chạy` — `cleanup.skipped` rỗng nên không phải kiểu `warn`. Bridge đóng lịch
sự bằng `POST /ui/api/shutdown` → `202`, pid biến mất, cả `home` lẫn repo scratch xóa được ngay sau đó. Script in
`READY <ui-url> task=…`, ghi `test-results/ui-check.json`, và giữ bridge sống cho tới khi được shutdown.

Live đợt 1 (2026-10-26), cùng cấu hình, hai lần — nền để so sánh:

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

Bối cảnh release: `main` đã nhận PR #28 và #29, `publish.yml` chạy xong và registry đang ở **0.1.20**
(`npm view agy-mcp-bridge time` → `2026-10-27T04:20:50Z`). Trước đó PR #28 và `publish.yml` từng fail vì một test
`evicted tasks lose their persisted record` (chỉ đỏ trên Linux); nguyên nhân và cách tái hiện ở mục 4, script đo
`test-results/diag-evict.mjs`, `test-results/diag-gate.mjs`.

## 4. Cách làm việc cho người tiếp theo

- Không tự nới quyền CLI khi gặp permission denial; không thêm cờ bypass; không mở bridge ra LAN/proxy công khai.
- Bridge cố ý không có token: chỉ dùng trên máy do chủ máy kiểm soát; bất kỳ tiến trình cục bộ cùng user đều điều
  khiển được agent.
- Trước khi đụng `manager.ts`: giữ nguyên thứ tự `flushOutput → parseResult → inspectScope → release owns lock →
  publish status → persist → appendUsage → release lane → finish → startNext`. Test
  `a worktree task never reports a final status before its owns scope is attached`
  và `a finished task records the agent process trees it released without delaying its status`
  (`tests/agents.test.ts`) chèn cả hai chiều của ràng buộc đó. Trạng thái cuối **không được** chờ một query tiến
  trình: mọi việc cần process table đều nằm trong chain `releaseOwnedTree` đã tách rời lane.
- Test không được phép gọi `powershell.exe`. `TaskManager` chỉ dùng `runtime.watchTree` khi được nối, mặc định inert;
  `createRuntime` (`src/runtime.ts`) là nơi nối `startTreeWatch`. Kể từ đợt 2, `reapOwnedTree` **cũng** gọi
  `listProcessesById` thật nếu test không inject `verify` — các test dùng pid giả bắt buộc phải truyền
  `verify: reRead(rows)`, nếu không mọi gốc đều bị coi là pid không còn tồn tại và `killed` rỗng.
- Không xóa `test-results/` trước khi mục 2.10 có quyết định — đó là đường tái hiện lỗi, không phải rác của phiên làm
  việc. Live test chỉ tạo scratch trong `%TEMP%` (`bridge-reap-*`, `bridge-ui-*`), không bao giờ trong repo. Muốn dọn
  một repo scratch bằng Python/`rm`: file trong `.git/objects` **read-only** trên Windows, phải `chmod S_IWRITE` đệ quy
  trước rồi mới `rmtree`, nếu không sẽ gặp `WinError 5 Access is denied`.
- `git worktree prune` mặc định chỉ dọn bản ghi cũ hơn `worktree.pruneExpire` (3 tháng) → luôn cần `--expire=now`,
  và `prune -v` in ra **stderr** nên muốn đếm số bản ghi đã dọn thì phải so `git worktree list --porcelain` trước/sau.
- Bản ghi task swap bằng `<id>.json.tmp` rồi `rename`, nên `readdir(state/tasks)` **có thể** trả cả tên `.tmp` khi một
  lần ghi đang chạy. Muốn đếm số bản ghi thì lọc `.json` — `restore()` và `TASK_RECORD` trong sweep đã làm đúng như vậy.
  Đây chính là cách `evicted tasks lose their persisted record` hỏng trên Linux mà không hỏng trên Windows.
- Bản vá muộn sau khi publish status (ghi `task.cleanup`) chỉ được viết khi manager vẫn còn giữ task đó. Retention có
  thể đuổi bản ghi trong lúc query tiến trình chưa về, và ghi tiếp sẽ **hồi sinh** record đã xóa. Test
  `a tree report that lands after eviction patches the record it still owns` (`tests/bridge.test.ts`) dựng đúng cửa sổ
  đó bằng cách cho `reapTree` chờ một gate; đã kiểm chứng là nó đỏ khi bỏ guard, trên cả Windows lẫn Linux.
- `gh pr merge --auto` merge **ngay lập tức** khi repo không có branch protection: nó đã gộp PR #28 khi 4 job CI còn
  đang chạy. Muốn "gộp khi CI xanh" thì chờ `gh pr checks --watch` rồi merge thủ công, hoặc bật ruleset yêu cầu
  `test (ubuntu/windows × 20/22)` — hiện repo chưa có ruleset nào.
- WSL Ubuntu có Node 20.20.2 và chạy được thẳng `dist/` build từ Windows qua `/mnt/c`; output của `wsl.exe` lẫn byte
  rỗng nên lọc `tr -d '\000'` trước khi đọc. Đó là đường lấy verdict Linux **trước** khi push, không phải bản thay
  thế CI (CI vẫn chạy matrix 20/22 trên cả hai OS).
