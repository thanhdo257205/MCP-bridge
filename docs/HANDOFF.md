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

### Đợt 3 — 2026-10-27: giao diện gọn theo "Xem thêm" + sửa `prefixArgs` bị rơi

| # | File | Nội dung |
|---|------|----------|
| 14 | `ui/app.js`, `ui/app.css` | Mật độ: helper `collapsible()`/`more()` dựng `<details class="more">` cho mọi văn bản trả lời "vì sao / nếu như" thay vì "bây giờ đang sao". Đầu trang chi tiết task còn **một** dòng meta (uuid và branch tụt xuống khối thông số), lưới 17 ô vào "Xem thêm thông số task"; các card Cài đặt đưa giải thích dài + callout "chưa kiểm chứng" ra sau nút Xem thêm — riêng cảnh báo *không xác thực* và cảnh báo *sandbox không phải giới hạn đường dẫn* ở mức Tự động/Toàn quyền vẫn luôn hiện; dòng hoạt động rút ngắn, phần giải thích thành tooltip; trang Sử dụng ẩn những ngày không có task và rút cột Usage về tổng token (breakdown trong tooltip). Đã xem bằng Chrome với bridge thật trong `%TEMP%` (4 task `agy`: hoàn tất / hết hạn / thất bại / đang chạy) |
| 15 | `src/antigravity/process.ts`, `src/runtime.ts`, `src/agents/registry.ts`, `src/agents/antigravity.ts`, `src/models.ts`, `src/tasks/manager.ts` | `resolveCommand()` trả `{executable, prefixArgs}` — với `.cmd` shim thì `executable` là `node.exe` và `prefixArgs` là script của CLI. Cả ba chỗ dùng lệnh Antigravity giờ đều nối `prefixArgs` trước args của mình: probe (`inspectCli` nhận nguyên `ResolvedCommand` thay vì mỗi `executable`), launch (`AntigravityInspection.prefixArgs` → `AgentRuntime.prefixArgs`, kèm đường `legacyAntigravityAgent`), và `agy models` (`listModels(..., prefixArgs)` qua `Runtime.prefixArgs`). Trước đó cả ba hỏi/bắt `node.exe` mà thiếu script: `agy` cài bằng npm shim bị báo `unsupported`, và vì `DEFAULT_ENABLED = ['antigravity','codex']` nên **Codex thật âm thầm thành default agent**; `availableModels()` thì luôn fail ở trang Cài đặt trên máy đó |
| 16 | `tests/agents.test.ts`, `tests/hardening-inspection.test.ts` | `agy.cmd` + `agy.js` thật trong `%TEMP%` đi hết đường resolve → probe → registry → invocation → `availableModels()`; test thứ hai so **argv chính xác** của hai lần probe. Trên nền không-Windows (không có shim) dựng `ResolvedCommand` thủ công để phần nối args vẫn được phủ |

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
| Probe gọi `run(command.executable, args, cwd)` (bỏ `prefixArgs`) | 3 test: `CLI accepts the 1.4 patch family…`, `CLI inspection asks the command that was resolved…`, `a shimmed Antigravity keeps its script…` | **Đỏ**, và diff argv nói thẳng: actual `['…node.exe','--version']` thay vì `['…node.exe','…inspect-agy.mjs','1.4.7','','--version']` — đúng lỗi production |
| Registry không truyền `prefixArgs` cho agent Antigravity | `a shimmed Antigravity keeps its script from the probe through to the launch` | **Đỏ** riêng phần launch: `agent.prefixArgs` → `actual: undefined, expected: ['…agy.js']` |
| `availableModels()` bỏ tham số `prefixArgs` cuối | cùng test trên | **Đỏ** riêng phần models: `agy models` không trả về danh sách |

Unit Windows đợt 3, ngày 2026-10-27, sau khi sửa xong cả ba chỗ: **222 test, 216 pass, 0 fail, 6 skipped**, 245,0 s,
exit 0. So với đợt 2 đúng hai test mới (mục 16), số skipped không đổi. Ba mutation trên được tháo **từng chỗ một**,
mỗi lần chỉ đỏ đúng test tương ứng, rồi khôi phục và chạy lại cả suite.
Smoke live với `agy` thật trên máy phát triển (CLI ở đó là **native exe chứ không phải shim**, scratch config +
`BRIDGE_HOME` trong `%TEMP%`, `PORT=0`, chỉ probe chứ không giao task):
`[bridge] Agent antigravity: ready 1.4.7` — nên đường của người dùng cũ không đổi hành vi; bản sửa này mở đường
cho cách cài `agy` qua npm `.cmd`, chưa có máy shim thật để đo.

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

## 5. Đợt 4 — 2026-10-27: Phase 2 "mission" — bridge ghi nhận và chặn, agent ngoài điều khiển

Bốn quyết định chủ máy chốt **trước** khi viết code (không phải suy ra từ tài liệu):

| Câu hỏi | Đã chốt |
|---|---|
| Phạm vi | Phase 2 của `docs/MULTI-AGENT-PLAN.md`: mission daemon + skill orchestrator |
| Ngữ nghĩa | Bridge **ghi nhận và chặn, không tự chạy**: lưu plan + trạng thái từng bước, từ chối dispatch bước có phụ thuộc chưa `completed`, plan chỉ đọc và chỉ được nối thêm, **không bao giờ** tự khởi động một bước. Khởi động lại khôi phục plan nhưng không chạy lại gì |
| Sản phẩm | Cả hai: trang **Nhiệm vụ** trong UI **và** skill thứ hai riêng `mission-orchestrator` (không gộp vào `antigravity-bridge`) |
| Đường giao | Nhánh mới từ `main` → push → PR → **chờ chủ máy duyệt**; không merge, không kích bản phát hành npm |

### 5.1 Đã làm

| # | File | Nội dung |
|---|------|----------|
| 17 | `src/missions/missions.ts` (mới, 427 dòng) | `MissionManager` + schema. Plan tối đa `MAX_STEPS_PER_MISSION = 12` bước, cả plan dưới `MAX_MISSION_CHARACTERS = 100000` ký tự, giữ tối đa `MAX_RETAINED_MISSIONS = 20` bản ghi; `step_id` là slug `[a-z0-9][a-z0-9._-]{0,63}`; mọi schema `.strict()` nên field lạ bị từ chối ngay ở cửa. Chu trình sống: `create` (validate graph: trùng id, tự tham chiếu, phụ thuộc lạ, chu trình, workspace ngoài allowlist, timeout vượt trần) → `extend` (nối bước khi còn `open`) → `dispatch` (bốn lớp chặn, rồi mới tới `TaskRunner.delegate`) → `view`/`planOf` (trạng thái **suy ra từ task record tại lúc đọc**) → `cancel`. Bản ghi swap `<id>.json.tmp` + `rename`; `restore()` chỉ nhận file có tên khớp `MISSION_FILE` **và** id bên trong trùng tên; text dạng secret bị `redact` trước khi chạm đĩa |
| 18 | `src/runtime.ts`, `src/index.ts`, `src/http.ts`, `src/stdio.ts` | Nối `MissionManager` vào cả ba transport (HTTP MCP, stdio, UI) và `createRuntime`; lúc khởi động chỉ log `Restored N mission plan(s) … (no step is dispatched by itself)`; `environment` thêm `supported.missions` + `limits.max_mission_steps` / `max_retained_missions` + caveat "restart không tự dispatch"; `/health` thêm `missions` overview |
| 19 | `src/tools/register.ts` | Sáu tool mới: `mission_create`, `mission_extend`, `mission_dispatch`, `mission_status`, `mission_plan`, `mission_cancel`. Hợp đồng tiết kiệm token: create/extend trả **receipt** không echo plan; dispatch khi bước còn chạy trả đúng 6 trường + `next_step: wait`; `mission_status` không có text task; chỉ `mission_plan` mang `delegate` (và tool description nói rõ khi nào gọi nó); `next_step` do `missionNote(view)` tính từ chính plan chứ không chép từ mô tả; `client` của plan lấy từ `clientInfo`/User-Agent lúc gọi |
| 20 | `src/ui/routes.ts`, `ui/app.js`, `ui/app.css` | `GET /ui/api/missions`, `GET /ui/api/missions/:uuid`, `POST /ui/api/missions/:uuid/cancel` (bắt buộc `confirm: true` và **cố ý không** truyền `cancelRunningTasks`). Trang "Nhiệm vụ": header đếm plan đang mở / bước sẵn sàng / bước đã ghi, callout "bridge không tự bắt đầu bước nào", mỗi plan một card với pill trạng thái, bảng bước (trạng thái, "Chưa qua vì", agent + worktree + cảnh báo ngoài phạm vi, nút id task nhảy sang trang Task), và khối "Yêu cầu đã ghi cho từng bước" đọc `mission_plan` khi được bấm. Nút "Dừng kế hoạch" hỏi confirm một lần rồi mới gọi API |
| 21 | `skills/mission-orchestrator/SKILL.md` (mới, 82 dòng), `scripts/install-skill.ts`, `src/cli.ts`, `src/onboarding.ts`, `skills/known-versions.json` | Skill thứ hai **riêng**, không nhét thêm vào skill cũ. Installer giờ liệt kê mọi thư mục dưới `skills/` (`packagedSkills()`), nhận `--skill <name>` lặp lại, và `known-versions.json` đổi thành **lịch sử sha256 theo từng skill** để `--update` chỉ thay bản do package viết ra; onboarding đề nghị cả hai skill và log nêu tên từng cái |
| 22 | `tests/missions.test.ts` (mới, 17 test), `tests/helpers.ts`, 15 file test cũ đổi chữ ký, `tests/package.test.ts` | `helpers.missionsFor(manager, workspace, maxTimeout)` để mọi test HTTP/stdio không liên quan mission vẫn dựng được bridge. `TaskRunner` giả cho phép dựng từng kịch bản gate mà không cần CLI: graph, gate phụ thuộc, single-flight, rebound/append-only, `lost` khi retention đuổi record, đuổi bản ghi im lặng, restart không tự dispatch, file lạ bị bỏ, redact trước khi ghi, surface MCP, và route UI. Hai test `tools/list` đổi 7 → **13**. `package.test.ts` thêm đúng một dòng: tarball phải chứa **cả hai** skill |
| 23 | `scripts/live.ts` | Thêm nguyên một pha mission chạy trên `agy` thật: `expectRefused()` assert lời từ chối là `isError` **và** đúng nguyên văn lý do; ba bước phụ thuộc chạy thật rồi so `final_response` với đúng chữ plan đã ghi; sau đó là các cửa rebound / append-only / cancel / extend-sau-cancel |

Hành vi không đổi, cố ý giữ: bind `127.0.0.1`, kiểm tra Host/Origin, **không** xác thực token, không cờ bypass
permission, không tự merge worktree, hard-deny deploy/publish/xóa dữ liệu/push nhánh bảo vệ/đọc credential/thay đổi hệ
thống ngoài workspace — và vì mọi bước mission đi qua `TaskManager.delegate` nên toàn bộ các lớp đó áp dụng y nguyên.

### 5.2 Bằng chứng — đơn vị trên **đúng nhánh PR**, tách khỏi cây dev

Nhánh `qoder/phase2-mission` được checkout bằng `git worktree` ở thư mục tạm, chỉ gồm `main` + các file của đợt này,
nên số liệu nghiệm thu không lẫn với work chưa commit của agent khác đang dùng chung thư mục làm việc.

| Nền | Lệnh | Kết quả |
|---|---|---|
| Windows, Node 24.15.0 | `npm run build` rồi `node dist/scripts/run-tests.js` (`--test-concurrency=1`) | **240 test · 234 pass · 0 fail · 6 skipped**, 320,7 s, exit 0 |
| Linux (WSL Ubuntu, Node 20.20.2, `dist/` build từ Windows chạy thẳng qua `/mnt/c`) | `node dist/scripts/run-tests.js` | **240 test · 239 pass · 0 fail · 1 skipped**, 257,3 s, exit 0 |

Cả hai nền đều chạy **sau** ba bản sửa cuối của đợt này (bỏ escape trong `scripts/live.ts`, hai lỗi render ở
`ui/app.js`, một dòng mới trong `tests/package.test.ts`), nên số liệu là của đúng đầu commit sẽ được push.

Sáu dòng `# SKIP` trên Windows là năm test POSIX-only + `cli: --open …`; một dòng skip trên Linux đúng là
`Windows .cmd shims resolve to a local Node entry without a shell`. Mười bảy test mission
(`tests/missions.test.ts`, số 138–154 trên Linux) **xanh trên cả hai nền**.

### 5.3 Bằng chứng — mười guard, cái nào cũng được chứng minh "bỏ ra là đỏ"

Môi trường thử là **bản sao cô lập** của repo (junction `node_modules`, snapshot `.pristine`, restore + build lại sau
mỗi phép thử) — không bao giờ build đè `dist/` của cây đang dùng chung. Mỗi phép thử chỉ sửa **một** dòng, build lại,
rồi chạy **đúng test được nêu tên** (`--test-name-pattern`, `--test-timeout=15000`, limit cứng cho tiến trình con;
treo = đỏ). Kết quả: **10/10 đỏ**.

| # | Guard bị bỏ (hoặc bị nới) | Test được chỉ định | Cách đỏ |
|---|---|---|---|
| M1 | `if (unmet.length) throw` — chặn phụ thuộc chưa `completed` | `a step starts only after every dependency its plan names has completed` | fail 132 ms |
| M2 | `if (this.inFlight.has(key)) throw` — single-flight | `two concurrent dispatches of one step cannot both reach the runner` | **treo** tới timeout 15 006 ms: không có guard thì lời gọi thứ hai kẹt thật, không phải chỉ "trả lời sai" |
| M3 | `if (step.task_id) throw` — bước đã bind là vĩnh viễn | `the plan is append-only: a retry is a new step and the old one stays bound` | fail 239 ms |
| M4 | `if (options.cancelRunningTasks)` → `?? true` | `cancel closes the plan without touching a running agent, unless it is asked to` | fail 474 ms |
| M5 | thêm auto-dispatch vào `restore()` (đúng cái "daemon" mà quyết định đã loại) | `a restart restores plans with task-derived states and dispatches nothing by itself` | fail 325 ms |
| M6 | kiểm tra "tên file phải khớp id bên trong" | `a mission record this project did not write is skipped, never loaded or deleted` | fail 55 ms |
| M7 | `validateWorkspace` truyền `[...allowed, input.workspace]` (tự nới allowlist) | `create canonicalizes an allowed workspace and refuses one outside the allowlist` | fail 51 ms |
| M8 | `isQuiet` luôn đúng (`states.size >= 0`) | `retention drops the oldest plan with nothing in flight and keeps one that is running` | fail 1 026 ms |
| M9 | route UI cancel truyền `cancelRunningTasks: true` | `the UI reads a plan and its cancel closes the plan without stopping the agent it names` | fail 2 390 ms |
| M10 | early-return khi plan đã canceled (làm mất tác dụng `cancel_running_tasks` ở lần cancel thứ hai) | `cancel closes the plan without touching a running agent, unless it is asked to` | fail 424 ms |

Hai ghi chú kỹ thuật của chính phép thử (không phải của sản phẩm): `false && step.task_id` và
`step.task_id && false` đều làm tsc mất narrowing (`TS18048`), còn `mission.status === 'canceled'` chèn sớm thì
`TS2367` vì nó so hẹp hơn union — phải viết `(mission.status as string) === 'canceled'`. Và M2 chứng minh luôn vì sao
refusal cần tồn tại: không có nó thì client **chết đói**, không phải nhận lỗi.

Một guard thứ mười một của đợt này nằm ở bao bì, không ở mission: `tests/package.test.ts` giờ liệt kê
`skills/mission-orchestrator/SKILL.md` vào danh sách tarball bắt buộc. Đã thử bằng cách thu `files` trong
`package.json` thành `skills/antigravity-bridge/` → test đỏ đúng `AssertionError: missing
skills/mission-orchestrator/SKILL.md`, rồi khôi phục `package.json` (md5 xác nhận trùng bản gốc).

### 5.4 Bằng chứng — `agy` thật, transport streamable-http

`node dist/scripts/live.js` chạy trên đúng nhánh (bridge thật + `agy` 1.4.7, scratch trong `%TEMP%`): **exit 0**,
`success: true`, `workspace_unchanged: true` cho cả phần task đơn lẫn phần mission. Những gì phần mission chứng minh
được mà unit test không tự xưng được:

- Ba bước `a → b → c` chạy bằng agent thật, mỗi bước trả đúng `BRIDGE_MISSION_<id>` mà plan đã ghi; task id thật
  `d176b699…`, `091df081…`, `37782405…`. `progress` cuối `{total:3, completed:3, active:0, ready:0, pending:0, unmet:0}`.
- Sáu lời từ chối là hành vi production, nguyên văn: `step "b" is not ready: "a" is ready`,
  `step "c" is not ready: "b" is pending`, `step "a" is already bound to task … (completed); the plan is append-only,
  so dispatch a new step to try again` (cả hai cửa rebound và retry),
  `mission … is canceled: no step can be dispatched`, `mission … is canceled; its plan can no longer change`.
- Receipt không echo plan: assert chuỗi trả về không chứa `BRIDGE_MISSION_a`.
- `mission_extend` vào plan đã xong vẫn mở đúng bước mới (`ready: ['d']`), rồi cancel đóng cửa cả extend lẫn dispatch.
- Live test restart bridge giữa chừng và log nói đúng điều đã chốt:
  `Restored 1 mission plan(s) from .bridge-state/missions (no step is dispatched by itself)`.

Lần chạy live **đầu tiên đỏ vì chính harness**, không vì sản phẩm: `expectRefused` so regex vào chuỗi JSON nên dấu
trích dẫn trong lý do lỗi bị escape (`\"a\"`) và không khớp. Đó là bằng chứng gate hoạt động (thông báo in ra đúng
`step "b" is not ready: "a" is ready`), và bản sửa là bỏ escape trước khi assert.

### 5.5 Bằng chứng — trang Nhiệm vụ xem bằng Chrome

`test-results/ui-mission-check.mjs` (gitignored) dựng bridge scratch với plan ba bước: `write-note`
(`isolation: worktree`, `owns: ['note.txt']`) → `report-back` → `final-summary`, rồi giữ bridge sống để mở trình duyệt.
Đã bấm thật trên `http://127.0.0.1:<port>/ui/`:

- Bảng bước hiện đúng `Hoàn tất / Đang chạy / Sẵn sàng`; cột "Chưa qua vì" là `—` cho bước gốc và `đủ phụ thuộc` khi đã
  mở; cột agent thành `mặc định · worktree`; nút id task **nhảy thật** sang trang Task và trang Task chọn đúng task đó.
- Bước worktree có `scope {checked: true, changed: 1, out_of_scope: 0}` → không có cảnh báo phạm vi, đúng chủ đích.
- "Dừng kế hoạch" hỏi confirm bằng nguyên văn *"Task đang chạy vẫn chạy tới khi xong và vẫn hủy được riêng ở trang
  Task"*; sau khi xác nhận: pill `Đã dừng`, nút dừng biến mất, **bước đang chạy vẫn `Đang chạy` rồi tự hoàn tất**
  (đếm thành `3/3 hoàn tất`) — đúng quyết định "UI không giết agent".
- Hai lỗi **chỉ lộ ra khi xem bằng trình duyệt**, đã sửa trong đợt này: (1) khối "Yêu cầu đã ghi cho từng bước" in ra
  `[object HTMLLIElement],[object HTMLParagraphElement],…` vì mảng node truyền vào `details()` mà không spread như quy
  ước ở `changesBody`; (2) pill trong khối đó đóng băng theo snapshot lúc mở panel (hàng bảng đã `Đang chạy` nhưng panel
  còn `Sẵn sàng`) — panel giờ lấy trạng thái từ danh sách tươi, văn bản đã ghi vẫn là snapshot vì plan không đổi được.
- Console chỉ còn một issue a11y có từ trước (hai input thiếu `id`/`name` ở trang Cài đặt); diff này không thêm input nào.

Hai bản sửa UI đó **không có test tự động**: repo không có hạ tầng DOM test và test 17 dừng ở HTTP route. Đường kiểm
chứng là Chrome, và người sau sửa trang này phải xem lại bằng Chrome — đừng giả định suite xanh nghĩa là trang đúng.

### 5.6 Việc còn mở của Phase 2

1. **Cố ý không có `mission_list`**: mất `mission_id` thì đọc trên trang Nhiệm vụ, không tạo plan mới để "đoán lại".
   Đã ghi cả trong skill, README và tool description.
2. Plan không có role/priority: role (Tech Lead, Reviewer, Tester…) chỉ là chữ trong `task`, bridge không hiểu ngữ
   nghĩa. Bảng role của kế hoạch thuộc Phase 4.
3. `fallback: true` (chọn agent khác khi agent được chỉ định không sẵn sàng) vẫn chưa làm — từ Phase 1.
4. Ngân sách theo **mission** chưa có; usage vẫn chỉ theo task và theo ngày, nên một plan 12 bước không có trần chi phí.
5. Trang UI chỉ đọc + dừng, **không có nút dispatch** — có chủ đích: khởi động bước là quyết định của client MCP.
6. Chưa live-test plan có bước chạy bằng `codex` vì CLI đó trên máy này hết auth (401 `token_revoked` / 402
   `deactivated_workspace`); mọi bước live đều là `agy`. Cần `codex login` rồi chạy lại `scripts/live.ts`.
7. Retention mission (20) đuổi bản ghi **kẻ trước, không hỏi**: plan cũ bị đuổi thì bước của nó thành `lost` mãi mãi.
   Chưa có cảnh báo chủ máy, chưa có cách "ghim" một plan.

### 5.7 Quy tắc cho người tiếp theo (mission)

- **Không thêm bất kỳ chỗ nào để bridge tự dispatch.** `restore()` chỉ nạp bản ghi; mọi đường khởi động phải đi qua
  `dispatch()` với bốn lớp chặn theo đúng thứ tự: canceled → đã bind task → phụ thuộc chưa `completed` → single-flight.
  Thứ tự này có nghĩa: lý do lỗi phải là lý do *đầu tiên* đúng, vì client ra quyết định theo chuỗi đó. M1–M3, M5, M10
  đều đỏ khi bỏ một lớp.
- `mission_cancel` **không phải** nút dừng tiến trình. Mặc định `cancelRunningTasks` là false; MCP tool chỉ truyền cờ
  này khi client nói rõ `cancel_running_tasks: true`, còn `src/ui/routes.ts` thì **không bao giờ** (M9). Muốn dừng hẳn
  thì gọi `antigravity_cancel_task` cho từng task — đó là một quyết định phá hủy riêng.
- Plan chỉ đọc với worker và **chỉ nối thêm** với orchestrator: `step_id` đã bind là vĩnh viễn, không có "dispatch lại
  bước cũ cho đỡ tốn". Đó là cửa để hai agent giẫm nhau, và cũng là lý do `lost` không bao giờ mở khoá bước sau nó.
- Trạng thái bước luôn tính tại lúc đọc từ task record, không lưu sẵn. `lost` nghĩa là *bridge đã đuổi record*, không
  phải *agent báo lỗi* — đừng suy ra gì về nội dung workspace từ một bước `lost`.
- Bản ghi mission swap bằng `.json.tmp` + `rename` giống hệt task record (cùng cái bẫy đã ghi ở mục 4): muốn đếm bản
  ghi phải lọc theo `MISSION_FILE`, và `restore()` phải bỏ file có id bên trong không khớp tên — đó chính là M6.
- Retention chỉ đuổi bản ghi **im lặng** (không còn `queued`/`running`) và giữ plan đang chạy: M8 đỏ nếu `isQuiet` bỏ
  qua điều đó.
- Giữ hợp đồng token của surface MCP: receipt không echo plan, dispatch khi chạy chỉ 6 trường, `mission_status` không
  có text task, chỉ `mission_plan` mang `delegate`. Test `MCP surface: receipts omit the plan, the gate reads as a tool
  error, a running step says wait` giữ cả bốn, và `tools/list` nay là **13** tool (test stdio + test HTTP đã đổi theo).
- Skill thứ hai là `skills/mission-orchestrator/SKILL.md`: đổi nó thì **phải** nối sha256 vào `skills/known-versions.json`
  (test `skill-update` enforce), và `tests/package.test.ts` giờ đòi cả hai skill có mặt trong tarball — thiếu một là
  `agy-mcp-bridge skill install --skill mission-orchestrator` hỏng trên máy cài bằng npm.

