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
8. ~~**`pruneWorktrees` có blast radius toàn repo**~~ **(Đã thu hẹp 2026-10-31.)** `git worktree prune` không chọn
   được từng bản ghi nên không còn được gọi: `pruneWorktrees(repo, worktreesRoot)` xóa từng thư mục
   `<common-dir>/worktrees/<name>` đúng cách prune làm, chỉ khi thư mục worktree **đã mất**, nằm dưới
   `.bridge-state/worktrees/` và **không bị `git worktree lock`**. Worktree người dùng tạo tay và bản ghi bị khóa giữ
   nguyên (`tests/isolation-worktree.test.ts`, test "pruning clears the bridge worktrees…", đã thử bỏ điều kiện phạm vi
   thì đỏ). Còn mở: một worktree do bridge tạo mà người dùng chuyển ra ngoài `.bridge-state/worktrees/` rồi mất thì
   bản ghi của nó ở lại; `git worktree prune` thủ công vẫn dọn được.
9. **`removeWorktree` thực tế chỉ chạy ở một nhánh hẹp** (launch chưa kịp spawn). Worktree của task hoàn tất được
   giữ lại có chủ đích, nên đường EBUSY của nó chỉ được chứng minh bằng test mô phỏng, chưa bằng production.
10. ~~**Chưa commit/push/release đợt 2**~~ **(Lỗi thời: đợt 2 đã vào `main` và phát hành từ lâu.)** Phần còn đúng là việc
    chốt số phận `test-results/`. Ghi chú gốc: chưa xin xác nhận của người dùng cho lần thay đổi này (lần chấp nhận trước chỉ
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
- **Đọc bằng chứng phát hành: đừng tin lần hỏi registry đầu tiên.** `publish.yml` không có `paths` filter nên **mọi**
  push vào `main` — kể cả commit chỉ sửa docs — đều chạy CI rồi semantic-release và publish npm. Ngay sau khi job in
  `+ agy-mcp-bridge@0.1.23`, cả `npm view`, packument tải trực tiếp, `curl` và `npm pack` đều vẫn trả **0.1.22** hoặc
  404 trên đúng URL `.tgz`: npm đang ghi ("Your package is being processed and may take a few minutes to become
  available") và CDN giữ **negative cache** cho URL vừa 404. Kết luận "chưa lên" từ lần hỏi đó là **sai**. Đường đúng:
  (1) lấy log job publish và `git tag --points-at <release commit>`; (2) hỏi packument với cache-buster (thêm query
  `?cb=1` → 200 ngay khi URL sạch vẫn 404); (3) nghiệm thu bằng **artifact**: `dist.shasum`/`integrity` trong packument
  khớp `sha1sum` file tải về thật, rồi kiểm `files` trong tarball (hai skill có mặt, `docs/HANDOFF.md` không có). Với
  0.1.23: shasum `882463797cd5753aa102e4775c11747ee9581550`, unpackedSize 526947, tag `v0.1.23` → `904307a`.

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
3. ~~`fallback: true`~~ **Quyết định không làm (2026-10-31)** — xem `docs/SMART-ROUTER-PLAN.md`: failover có tên là pool.
4. Ngân sách theo **mission** chưa có; usage vẫn chỉ theo task và theo ngày, nên một plan 12 bước không có trần chi phí.
5. Trang UI chỉ đọc + dừng, **không có nút dispatch** — có chủ đích: khởi động bước là quyết định của client MCP.
6. Chưa live-test plan có bước chạy bằng `codex` vì CLI đó trên máy này hết auth (401 `token_revoked` / 402
   `deactivated_workspace`); mọi bước live đều là `agy`. Cần `codex login` rồi chạy lại `scripts/live.ts`.
   **(Đã hết hiệu lực 2026-10-28: `codex` 0.163.0 chạy lại bình thường, một task codex thật đã live-xanh — xem mục 6.3.
   Phần còn đúng: các **bước mission** vẫn chưa chạy bằng codex.)**
7. Retention mission (20) đuổi bản ghi: plan bị đuổi thì bước của nó thành `lost` mãi mãi. **(Đã đổi 2026-10-31.)** Plan đã xong
   hoặc đã hủy (không còn bước `ready`/`pending`) bị đuổi **trước**, kể cả khi nó mới hơn một plan còn việc; chỉ khi mọi plan
   đều còn việc thì plan cũ nhất mới bị đuổi, và log ghi `WARNING: dropped mission record … with N step(s) not yet
   dispatched`. Vẫn chưa có cách "ghim" một plan và chưa có cảnh báo trên UI.

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
  error, a running step says wait` giữ cả bốn, và `tools/list` khi đợt này kết thúc là **13** tool (test stdio + test
  HTTP đã đổi theo). Đầu nhánh `antigravity` sau đó nối thêm `code_search`, nên con số hiện tại là **14** — xem mục 6.
- Skill thứ hai là `skills/mission-orchestrator/SKILL.md`: đổi nó thì **phải** nối sha256 vào `skills/known-versions.json`
  (test `skill-update` enforce), và `tests/package.test.ts` giờ đòi cả hai skill có mặt trong tarball — thiếu một là
  `agy-mcp-bridge skill install --skill mission-orchestrator` hỏng trên máy cài bằng npm.

### 5.8 Bản sửa đến SAU khi mục 5 viết xong — `b2da0cb`, "thư mục đúng nhưng spelling khác"

Chính CI Windows tìm ra, không phải test cục bộ: thư mục temp của runner là **đường dẫn ngắn** (dạng 8.3), nên
`realpath()` trả một chuỗi khác hẳn chuỗi client đã gửi dù trỏ cùng một chỗ. Hệ quả: `create()` lưu workspace đã
canonical hóa trong khi từng bước của plan vẫn giữ nguyên spelling client gửi vào; `mission_extend` sau đó so chuỗi
của client với chuỗi canonical và **từ chối đúng cái thư mục mà mission đang chạy thật**.

Bản sửa (`src/missions/missions.ts`, +25 dòng): `create()` lưu **một** spelling cho cả bản ghi, còn `extend()` giải
mỗi spelling khác nhau mà client gửi **đối chiếu vào** thư mục của mission **trước** khi áp quy tắc plan — chỉ spelling nào đáp
xuống đúng thư mục đó mới được nhận, mọi spelling khác vẫn bị từ chối bằng nguyên văn lý do của plan.

Test hồi quy: `the single-workspace rule gates on the directory, not on how the client spelled it`
(`tests/missions.test.ts`, +23 dòng) — assert bản ghi giữ đường dẫn canonical, assert mọi bước (đã ghi và vừa nối)
chạy trong cùng thư mục canonical, và assert "một lời append bị từ chối thì không thêm gì vào plan". Test này **đỏ**
khi bỏ phép giải spelling và **xanh trên cả hai OS**, nên lớp lỗi này không còn phụ thuộc vào máy nào chạy suite.

Số liệu của đúng đầu nhánh sau bản sửa, lấy từ log CI run `40549136043` (commit merge `f7f8121`, bốn job matrix):

| Nền | Kết quả |
|---|---|
| Windows 22 và Windows 20 | **241 test · 235 pass · 0 fail · 6 skipped** (bốn job cùng số) |
| Ubuntu 22 và Ubuntu 20 | **241 test · 240 pass · 0 fail · 1 skipped** |

PR #31 merge, `main` = `f7f8121`, job publish in `+ agy-mcp-bridge@0.1.22` và tag `v0.1.22` → `cc5ef99` (xem mục 4 về
cách đọc bằng chứng phát hành: `npm view` có thể trả số cũ vì cache registry).



## 6. Đợt 5 — 2026-10-28: duyệt nhánh `antigravity`, sửa bốn lỗi trước khi merge

Nhánh `antigravity` (`a51b53f` + `f503ea0`, 22 file, **+1868/−30** so với `main`) do một agent khác viết: **agent
profiles** (env riêng, sandbox/approval riêng), **quota failover pool** và **XERJ code search**. Chủ máy chốt ba câu
hỏi **trước** khi sửa:

| Câu hỏi | Đã chốt |
|---|---|
| XERJ (`code_search` + auto-reference) | **Gộp vào `main` nhưng default off**: muốn dùng phải tự sửa `workspaces.json` |
| Codex `danger-full-access` / `ask-for-approval never` | **Giữ** quyền cấu hình (chỉ chủ máy bật được) **kèm cảnh báo lúc khởi động**; ví dụ shipped hạ về mức an toàn |
| Bốn lỗi tìm thấy khi duyệt | **Sửa xong rồi mới merge**, không merge trước rồi fix sau |

Ba commit của đợt này: `b07db73` (merge `main` vào nhánh), `5f71769` (code + tests), `faffbe7` (test pin default
XERJ). Tài liệu (README + hai plan + mục này) đi commit riêng, đúng quy tắc tách nhóm commit.

### 6.1 Bốn phát hiện và bản sửa

| # | Phát hiện | Bản sửa |
|---|---|---|
| **F1** | **Mọi task Codex chết ngay khi spawn.** `--ask-for-approval` là cờ **toàn cục** của codex, không phải cờ của `exec`; nhánh cũ đặt nó **sau** `exec` nên `codex-cli 0.163.0` thoát với `unexpected argument`, prompt không bao giờ được đọc. Enum còn nhận `auto` và `always`, hai giá trị CLI không chấp nhận, và `config/workspaces.example.json` shipped đúng `"auto"` | `codexApprovalSchema = z.enum(['on-request','never'])` kèm chú thích vì sao chỉ hai giá trị đó; `src/agents/codex.ts` dùng `args.unshift('--ask-for-approval', …)` **trước** `exec`; example config về `on-request`; `codexSandboxSchema` giữ ba giá trị đo được `read-only|workspace-write|danger-full-access`; text fallback trong `src/agents/registry.ts` sửa `'auto'` → `'on-request'`. Grammar xác nhận bằng `--help` thật, không suy từ tài liệu |
| **F2** | **XERJ bật mặc định, và kết quả search trở thành chỉ thị.** `xerj.enabled` default `true`, cửa auto-reference chỉ là `auto_reference !== false` → mỗi task được giao đều bị gửi text sang một service local khác, và passage retrieve được **nối vào prompt mà agent tuân theo** | `xerjSchema.enabled` và `auto_reference` đều `default(false)`; cửa là `isXerjEnabled() && config.xerj?.auto_reference` (**cả hai** cờ, có chủ đích); `code_search` vẫn nằm trên surface nhưng throw `XERJ search is disabled: set "xerj.enabled" to true in workspaces.json` thay vì trả rỗng; `/api/xerj/status` short-circuit `enabled:false` **không gọi mạng**, `/api/xerj/search` trả 404 khi tắt |
| **F3** | **Failover làm mất lane và xóa lock của task khác.** Code cũ `rmdir` execution lock **trước** khi relaunch attempt kế tiếp (`entry.holdsLock` ngắn mạch nhánh mkdir), nên retry chạy mà không còn lock — và nếu một task thường khác kịp tạo lock mới thì cái bị xóa là lock **của nó** | Đường failover **không release gì cả**: task vẫn giữ lane tới khi xong. Test bắt tại lúc launch (`secondLaunchLock.held === true`), không suy từ log |
| **F4** | **Failover phi tang chứng cứ và có thể quay vòng.** Attempt bị bỏ bị ghi đè sạch (không còn error, exit code, log), và `selectProfile` không loại profile đã thử nên pool N thành viên cứ quay lại các member vừa cooldown | `attempts[]` trên `Task`: `agent, status, error, exit_code, signal, ended_at, duration_ms, stdout_tail, stderr_tail` (cắt ở `ATTEMPT_TAIL_CHARS = 4000` để không nhân bản bản ghi); `entry.poolTried` loại mọi profile đã đốt → pool N cho **tối đa N−1** retry, hết pool thì task **fail** chứ không treo; `summary()` cắt `attempts` (và `stdout/stderr/final_response`) nên poll không phình |

### 6.2 Bằng chứng — bảy guard, bỏ ra là đỏ

Cùng môi trường cô lập như mục 5.3 (junction `node_modules`, snapshot `.pristine`, restore + build lại sau mỗi phép
thử, sửa **một** dòng, `--test-name-pattern`, treo = đỏ). Kết quả: **7/7 đỏ**.

| # | Guard bị bỏ hoặc bị nới | Test được chỉ định | Cách đỏ |
|---|---|---|---|
| A1 | thêm lại `rmdir` lock trước khi relaunch (đúng lỗi F3) | `a quota failover keeps the lane it already holds and keeps the abandoned attempt as evidence` | fail 3 663 ms |
| A2 | bỏ `attempts.push` khi failover (lỗi F4) | cùng test trên | fail 2 617 ms |
| A3 | bỏ `tried` khi chọn profile kế tiếp | `failover visits each profile in the pool at most once and then fails the task` | fail 2 358 ms |
| A4 | quay cửa auto-reference về `auto_reference !== false`, bỏ điều kiện `enabled` | `a retrieved passage enters the prompt only when the owner enabled both XERJ flags` | fail 4 575 ms |
| A5 | bỏ lời từ chối trong handler `code_search` | `code_search is on the surface but refuses while XERJ is disabled` | fail 257 ms |
| A6 | `args.unshift` → `args.push` cho `--ask-for-approval` (đúng thứ tự lỗi F1) | `codexAdapter buildInvocation passes configured sandbox, approval and customEnv` | fail 3,3 ms |
| A7 | đặt lại default `xerj.enabled`/`auto_reference` thành bật | `the shipped defaults leave XERJ off` | fail 10,1 ms |

Hai test failover dựng agent giả bằng `fakeProfile()` (EventEmitter ép kiểu `ChildProcess`) nên **không cần CLI thật**
và chạy được trên mọi máy. Bẫy phải ghi lại: `globalHealthTracker` là **singleton module-level**, p1 để lại cooldown
sang test kế tiếp làm thứ tự retry thành `['p2','p1']`; phải gọi `healthyPool()` xóa cooldown cả p1 lẫn p2 ở **đầu mỗi**
test thì assertion thứ tự mới có nghĩa.

### 6.3 Bằng chứng — suite hai nền trên đúng đầu commit sẽ push

| Nền | Lệnh | Kết quả |
|---|---|---|
| Windows, Node 24.15.0 | `npm run build` rồi `node dist/scripts/run-tests.js` (`--test-concurrency=1`) | **261 test · 255 pass · 0 fail · 6 skipped**, 242,1 s, exit 0 |
| Linux (WSL Ubuntu, Node 20.20.2, `dist/` build từ Windows chạy thẳng qua `/mnt/c`) | `node dist/scripts/run-tests.js` | **261 test · 260 pass · 0 fail · 1 skipped**, 225,4 s, exit 0 |

Sáu dòng skip trên Windows là năm test POSIX-only cộng `cli: --open …`; trên Linux dòng skip duy nhất vẫn là
`Windows .cmd shims resolve to a local Node entry without a shell`. Assertion `tools/list` đã đổi **13 → 14** ở cả
`tests/http.test.ts` và `tests/bridge.test.ts` vì `code_search` được đăng ký kể cả khi XERJ tắt — có chủ đích: mặt tool
không phụ thuộc config của chủ máy, còn từ chối thì nói rõ lý do thay vì trả kết quả rỗng.

**CLI thật, hai cái.** `node dist/scripts/live.js` trên đúng đầu commit: **exit 0**, `success: true`,
`workspace_unchanged: true`, `reconnected: true`, `shutdown_with_active_task_verified: true`, server exit 0. Bridge boot
với `agy` **1.4.8** (không phải 1.4.7 như các đợt trước), task smoke `completed` exit 0 trả đúng `BRIDGE_SMOKE_OK`,
mission ba bước `a → b → c` cả ba `completed`, sáu lời từ chối vẫn nguyên văn (xem mục 5.4), task cancel `canceled`
exit 1, `denied_actions: []`.

Đường **codex** (tức F1) được nghiệm thu bằng script riêng `test-results/codex-live.mjs` (gitignored, không ship): config chỉ
bật `codex`, `codex_sandbox: read-only`, `codex_ask_for_approval: on-request`, delegate một task `agent: 'codex'` trong
workspace scratch ở `%TEMP%`. Kết quả: `agents_list` báo `codex 0.163.0 available: true` **không warning**, task
`completed`, **exit 0**, `final_response` đúng `CODEX_LIVE_OK`, `attempts: null` (không có failover), sentinel file
không đổi. Trước bản sửa thì chính lệnh này chết ngay khi spawn vì `--ask-for-approval` đứng sau `exec` — nên đây là
bằng chứng mà unit test không thể tự xưng.

Hai noise thực tế ghi lại để người sau không bất ngờ: `codex` stderr đầy
`rmcp::transport::worker ... error sending request for url (http://127.0.0.1:8080/mcp)` và config.toml của máy user bị
phàn nàn `features.rmcp_client is ignored` — cả hai là **config toàn cục của codex trên máy chủ máy**, không phải của
bridge, và không làm task fail.

### 6.4 Rủi ro đã chấp nhận, ghi lại chứ không sửa code

1. ~~**Relaunch failover là fire-and-forget.**~~ **(Đã sửa 2026-10-31.)** Lần relaunch giờ được `await` trong try/catch: nếu
   `launch` throw, task đi qua bước kết thúc bình thường với `failed` và lỗi `Failover to "<id>" could not start: …`
   (test `a failover whose retry cannot start ends the task and frees the lane…`, đã thử bỏ bản sửa thì đỏ).
2. ~~**Cây process của attempt bị bỏ không được reap**~~ **(Đã sửa 2026-10-31.)** Failover giờ dừng watcher và giải phóng cây
   của attempt bị bỏ **trước khi** launch retry (trần `REAP_BUDGET_MS`, cùng mức với lần giải phóng cuối); kết quả nằm ở
   `attempts[].cleanup`. Ghi chú gốc: chỉ cây của child cuối cùng được reap, nên worktree removal gặp `EBUSY`.
   Còn lại: lần chờ này cộng thêm tới vài giây vào độ trễ failover khi máy chậm; chưa đo trên `agy`/`codex` thật.
3. **`QUOTA_ERROR_PATTERNS` khớp rộng — đã thu hẹp một phần (2026-10-31).** Stdout, nơi có lời của chính agent, giờ chỉ bị
   quét bằng `STRONG_QUOTA_PATTERNS`; `429` phải đi kèm `http|status|code|error` hoặc `Too Many`. stderr và trường lỗi
   của CLI vẫn dùng bộ đầy đủ (kể cả `overloaded`, `rate limit`). **Chưa đối chiếu với lỗi quota thật của `agy`/`codex`**:
   nếu một CLI chỉ báo hết quota trên stdout bằng cụm không nằm trong danh sách mạnh thì failover sẽ không kích hoạt.
   `markCooldown` mặc định 900 s; cooldown nay được lưu ở `.bridge-state/cooldowns.json` nên restart không xóa nó.
4. **Env của profile đi thẳng vào child env**, không qua `childEnvironment` (bộ lọc strip secrets) — chủ đích, vì nó
   chỉ do chủ máy viết trong `workspaces.json`. Hệ quả: file đó là đường tin cậy, **đừng** nhét token vào `env`.

### 6.5 Việc còn mở của đợt này

1. ~~`tests/smart-pool.test.ts:131` gán pid ngẫu nhiên~~ **(Đã đổi sang `900_000 + n`, 2026-10-31.)** Ghi chú gốc: gán pid **ngẫu nhiên 1000–9000** cho child giả. Đã kiểm lại đường nguy hiểm:
   `reapOwnedTree` chỉ giết **root** là con của pid đã ghi, `alive(pid)` true thì trả về bất động, và `verify` đọc lại
   đúng các pid sắp giết — nên số ngẫu nhiên không với tới tiến trình lạ. Vẫn nên đổi sang pid cao như
   `tests/agent-profiles.test.ts` (`900_000 + n`) để không phải dựa vào lập luận đó.
2. **Failover chưa chạy bằng CLI thật.** Đường codex đơn lẻ đã live-xanh (mục 6.3), nhưng **chưa** có lần chạy thật nào
   đốt quota của profile thứ nhất rồi để profile thứ hai nhận task: muốn vậy cần hai profile đăng nhập thật và một lần
   hết quota thật. Hành vi đó hiện chỉ do hai test `fakeProfile()` chứng minh. Tương tự, chưa live-test plan mission có
   bước chạy bằng `codex`. (Trước 2026-10-27 `codex` trên máy này hết auth — 401 `token_revoked` / 402
   `deactivated_workspace` — nay đã dùng lại được, nên các mục cũ trong HANDOFF nói "codex không test được" là **hết hiệu lực**.)
3. ~~`fallback: true`~~ **Quyết định không làm (2026-10-31)** — xem `docs/SMART-ROUTER-PLAN.md`: failover có tên là pool.
4. Ngân sách theo pool/profile chưa có; usage vẫn chỉ theo task và theo ngày.

### 6.6 Quy tắc cho người tiếp theo

- **Hai cờ XERJ là hai cửa riêng biệt.** Đừng "tiện tay" gộp `enabled` và `auto_reference` làm một: passage lấy từ index
  nằm trong prompt agent, nên một kết quả search trở thành chỉ thị mà client không gửi. A4 đỏ nếu gộp.
- **Không release execution lock trong đường failover.** Task retry vẫn thuộc cùng một lane; A1 đỏ nếu thử lại cách cũ.
- **Cờ toàn cục của codex đứng trước `exec`** (A6) và enum approval chỉ nhận `on-request|never`. Cả hai là kết quả
  **đo** trên `codex-cli 0.163.0`; nâng CLI thì phải đo lại `--help`, không đoán.
- Attempt bị bỏ luôn còn trong `attempts[]` trên bản ghi, và luôn bị cắt khỏi `summary()`; đổi một trong hai thì A2 là
  test sẽ đỏ.
- Thêm hoặc bớt tool thì sửa **cả** `tests/http.test.ts:55` và `tests/bridge.test.ts:115` (`tools.length`), không chỉ một.

### 6.7 Đợt tài liệu 2026-10-28: mặt bằng profile / pool / `attempts` / `code_search` vào hai skill

Surface của PR #32 đã lên `main` nhưng hai skill shipped vẫn chỉ nói về **một** agent và **không** có `code_search`.
Đợt này sửa tài liệu, **không đổi runtime code**, năm file:

| File | Nội dung mới | Vì sao phải viết |
|---|---|---|
| `skills/antigravity-bridge/SKILL.md` (126 → 136 dòng) | `agents_list` có thể trả id **profile** và id **pool**, cả hai đều là giá trị `agent` hợp lệ; mục mới *When the agent you named is a pool*: mỗi thành viên lành chạy **tối đa một lần** rồi task `failed`, phải đọc và báo cáo `attempts[]` (`agent, status, error, exit_code, duration_ms`), retry **giữ nguyên execution lane** nên thời lượng worst case là (số thành viên × `timeout_seconds`), và việc phát hiện quota đọc **text** của CLI nên một agent chỉ *kể lại* chữ `429` / `overloaded` cũng đủ đặt profile vào cooldown; `code_search` luôn được advertise nhưng chỉ trả kết quả khi chủ máy bật XERJ — lời từ chối là **trạng thái cấu hình**, không phải lỗi để retry; không trường delegate hay câu chữ task nào nâng được quyền thật của agent | Agent ngoài đọc skill cũ sẽ retry mãi một pool đã cạn, hiểu nhầm lời từ chối của `code_search` là lỗi hạ tầng, hoặc xin chủ máy bật cờ nguy hiểm qua prompt |
| `skills/mission-orchestrator/SKILL.md` (82 → 84 dòng) | bước mission cũng nhận id profile/pool; **failover chạy lại trên đúng worktree cũ**, nên phần dở của attempt bị bỏ vẫn còn trong diff và tính vào `scope` của attempt sau; thêm dòng bảng "A pooled step ended `failed` with `attempts`" | Gate của mission là review diff **từng bước**; không nói điều này thì Tech Lead tưởng diff bước sau sạch từ đầu |
| `skills/known-versions.json` | hai hash mới: `antigravity-bridge` lên **17** bản, `mission-orchestrator` lên **2** | `tests/skill-update.test.ts` chỉ nhận SKILL.md có sha256 nằm trong danh sách |
| `docs/SMART-ROUTER-PLAN.md` §4 | bảng **kế hoạch vs. thực tế đã shipped** + danh sách việc còn mở, ưu tiên dần | Kế hoạch viết 2026-10-27 được người tiếp theo đọc như mô tả code |
| `docs/HANDOFF.md` §4 | quy tắc đọc bằng chứng phát hành (bullet cuối) | tham chiếu "xem mục 4" ở cuối §5.8 đang **treo**, chưa từng có bullet đó |

Năm điểm mà tài liệu cũ nói sai hoặc chưa nói, **đã đối chiếu lại code** chứ không suy từ kế hoạch:

1. **`isHardTask` có một rule chết.** `src/agents/quota.ts:44` kiểm `input.effort === 'high'`, nhưng `isHardTask` chỉ
   nhận `DelegateInput` (`src/security/input.ts:9-19`, `.strict()`, **không** có trường `effort`) → nhánh đó không bao
   giờ bật. Effort thật của agent đến từ `readEffort(stateDirectory)` — một cài đặt **toàn bridge do chủ máy chọn**,
   ghi vào `Task.effort` (`src/tasks/manager.ts:251`), không phải thuộc tính của task được delegate.
2. ~~**Ba `strategy` hành vi như nhau.**~~ **(Đã bỏ enum, 2026-10-31.)** `strategy` là chuỗi tùy chọn không có tác dụng; cấu
   hình cũ vẫn nạp được và bị cảnh báo. Ghi chú gốc: `quota-adaptive`, `priority-failover`, `round-robin` đều rơi vào
   `healthyMembers[0]`.
3. **Cooldown chỉ sống trong RAM.** `globalHealthTracker` là singleton module: restart bridge xóa hết cooldown, dù
   `quota_cooldown_seconds` (mặc định 900) vẫn ghi trong config. Không có file trạng thái cho việc này.
4. **Pool cạn lúc delegate báo lỗi gây hiểu nhầm.** `selectAgent` rơi khỏi nhánh pool rồi throw `Unknown agent "<pool id>"`
   (`src/tasks/manager.ts:153-155`) — client đọc sẽ tưởng mình gõ sai tên agent, trong khi sự thật là không thành viên
   nào lành. Bản ghi task cũng lưu id **profile đã chọn** chứ không lưu id pool: `Task` (`src/tasks/manager.ts:31-47`)
   không có field pool, `Entry.poolId` (`:78`) chỉ là trạng thái trong bộ nhớ, nên lịch sử và UI không tự nói task nào
   đi qua failover — chỉ `attempts[]` cho biết.
5. **Attempt reuse worktree.** `launch()` tái dùng `entry.worktreeInfo`, nên branch `bridge/<task_id>` mang diff của
   **cả** attempt bị bỏ; `scope.out_of_scope` của attempt cuối là một phần của tổng đó, không phải của riêng nó.

Quy tắc cho người tiếp theo:

- **Sửa SKILL.md thì commit hash cùng một commit.** Thiếu hash là `tests/skill-update.test.ts` đỏ ngay trên branch.
  Hash tính trên nội dung đã `normalize` (`\r\n` → `\n`, `scripts/install-skill.ts`), nên đổi line ending **không** làm
  hash đổi — đừng tưởng xóa file LF/CRLF là tương đương.
- **Tính hash lại ngay trước khi commit, và đừng sửa skill trong lúc suite đang chạy.** `tests/skill-update.test.ts` đọc
  `skills/*/SKILL.md` **từ đĩa** lúc test chạy, không đọc từ commit: một câu sửa sau khi đã ghi hash làm bản đang chạy
  mất giá trị, và nếu nó đỏ thì không rõ là đỏ vì nội dung hay vì race. Đã gặp trong đợt này và phải chạy lại cả suite.
- Tài liệu về router phải ghi **cả phần stub và phần chết**, không chỉ phần chạy được: người đọc kế hoạch cũ đã tưởng
  `priority-failover` là chiến lược thật và tưởng rule `effort` còn tác dụng.
- **PR chỉ-sửa-docs vẫn publish npm** vì `publish.yml` không có `paths` filter (mục 4). Vì thế đợt này đi nhánh + PR
  riêng, và **hỏi chủ máy trước khi merge** — gộp vào `main` là ra bản `0.1.24` trên registry.

Bằng chứng, chạy trên **đúng nội dung cuối** (hash `d0f94ad3…` đã nằm trong `known-versions.json`, SKILL.md 136/84 dòng):

- Windows, Node **24.15.0**: **261 test / 255 pass / 0 fail / 6 skipped**, 284,9 s, exit 0. Sáu dòng skip = năm test
  nhóm POSIX signal + `cli: --open hands the UI address…`.
- Linux (WSL Ubuntu, Node **20.20.2**, `dist/` build từ Windows chạy thẳng qua `/mnt/c`): **261 / 260 / 0 fail / 1 skipped**,
  228,2 s, exit 0. Một test skip là `Windows .cmd shims resolve to a local Node entry without a shell`.
- Hai lần chạy trước đó **không được tính**: một lần đang chạy thì tôi sửa một câu trong SKILL.md (nêu ở quy tắc trên),
  một lần bị stop để sửa; cả hai đều exit 0 nhưng verdict không còn áp dụng cho nội dung cuối.

### 6.8 Đợt 6 — 2026-10-28: config mẫu tự bẫy `agents.enabled`, và profile `antigravity` là công dân hạng hai

Chủ máy hỏi "đã thêm được tài khoản vào một profile riêng chưa". Trả lời bằng ba phép đo, không bằng đọc schema.
Ba driver (`profile-enabled-probe.mjs`, `agy-profile-live.mjs`, `agy-profile-argv-probe.mjs`) nằm trong `test-results/`
và **không commit** — đó là scratch gitignored, nên chúng chỉ còn giá trị mô tả; đủ chi tiết để viết lại ở mục "Quy tắc"
dưới. Scratch để trong `%TEMP%` của worktree, và không record nào rơi vào `%APPDATA%\agy-mcp-bridge` (nghiệm lại: 0 file
khớp task id của probe, file mới nhất vẫn là 2026-10-24).

| Phát hiện | Bằng chứng | Mức |
|---|---|---|
| Profile không nằm trong `agents.enabled` bị vô hiệu **âm thầm**, và pool của nó từ chối bằng **tên pool** | live: `Unknown agent "agy-trap-pool". Known agents: antigravity, codex, agy-trap`; gốc `registry.ts:74` + `manager.ts:153-155` | đo thật |
| Profile `codex` cần cả id `codex` trong `enabled`; thiếu thì `available: false` với **`warnings: []`** | probe registry, cấu hình `codex-off-profile-on`: `codex-work enabled=true available=false warnings=[]`; gốc `registry.ts:53` (chỉ probe CLI khi `codex` được bật) | đo thật |
| `enabled` trên `agents_list` nói dối với profile codex: luôn `true` dù profile bị vô hiệu | `codex.ts:88` hardcode `enabled: true`; nhánh antigravity truyền `isProfileEnabled` (`registry.ts:103`) — hai profile codex trong probe đều `enabled=true` kèm warning "Disabled in the bridge config" | đọc code, nhất quán với probe |
| Pool id đặt trong `priority` không chọn gì và cũng không cảnh báo | probe `pool-as-priority` → `default_agent: antigravity`; `registry.ts:29` coi pool id là id hợp lệ nên không warn, `:143` chỉ match agent id | đo thật |
| Profile `antigravity` **không nhận** model, quyền, soft-deadline mà chủ máy đã chọn | probe argv (CLI giả): base = `--model gemini-3-pro-high --mode accept-edits --log-file … --print-timeout 7200s`; profile = không có cả bốn, `--print-timeout 60s`. Gốc: `manager.ts:249` và `manager.ts:354` so sánh `adapter.id === 'antigravity'`, còn `registry.ts:102` put id profile vào adapter | đo thật |
| `agy` không tách tài khoản theo env | đổi `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` → vẫn đúng một tài khoản; credential lấy từ keyring Windows, đăng nhập là Google OAuth | đo thật |

Bản sửa đợt này **chỉ** động tới config mẫu, guard và tài liệu — không đổi hành vi runtime:

- `config/workspaces.example.json`: `agents.enabled` giờ liệt kê cả `codex-work` / `codex-backup` bên cạnh hai adapter.
  Chạy lại probe `ids-in-enabled`: hai profile `available=true`, pool route tới `codex-work:usable, codex-backup:usable`.
- Guard mới trong `tests/config.test.ts`: mỗi profile phải có trong `enabled` (kèm adapter gốc của nó), mỗi thành viên pool
  phải là profile đã khai báo, và `priority` không được chứa pool id. Bỏ bản sửa JSON ra thì đỏ ở
  `agents.profiles."codex-work" must also appear in agents.enabled`.
  Bốn assertion đều được chứng minh là **còn sống**, mỗi cái đỏ đúng một lần với đúng lỗi của nó (trên baseline đã sửa):

  | Phá gì | Đỏ ở |
  |---|---|
  | `enabled` bỏ `codex-work`/`codex-backup` (đúng bản lỗi gốc) | `agents.profiles."codex-work" must also appear in agents.enabled` |
  | `enabled` bỏ id `codex`, giữ hai profile | `agents.enabled must keep "codex": … "codex-work" is unavailable and reports no warning at all` |
  | `priority` = `["codex-smart-pool", …]` | `priority entry "codex-smart-pool" is a pool id, which silently selects nothing` |
  | pool member `codex-ghost` (thêm vào `enabled` để cô lập lỗi) | `pool "codex-smart-pool" names member "codex-ghost" which is not a declared profile` |
- README mục "Agents, profiles and pools" viết lại: bỏ câu "một máy chạy hai tài khoản song song" (đúng với codex, sai với
  antigravity), thêm bốn rule hay nhầm và ghi rõ profile antigravity thiếu gì, thiếu theo hướng **an toàn hơn**
  (không `--mode` = agy tự từ chối mềm), nên đây là mất năng lực chứ không phải vượt quyền.

Việc còn mở:

- **Đã làm ở đợt 7 (mục 6.9):** sửa hai phép so sánh id (`manager.ts:249`, `:354`) thành một marker "họ adapter" trên
  `AgentAdapter`. Chủ máy đã duyệt hệ quả trước khi code được viết: `--mode` giờ áp cho task chạy profile, tức là
  kể cả mức `full` → `--dangerously-skip-permissions`. Trước bản sửa, profile bị khóa ở mặc định của CLI.
- `Unknown agent "<pool id>"` nên nói thẳng "pool X không còn member nào usable (mỗi member phải có trong `agents.enabled`
  và CLI của nó phải khả dụng)" thay vì đổ tại tên agent.
- **Đã làm ở đợt 8 (mục 6.10):** `VERIFIED_AGY_VERSIONS` (`process.ts:9`) thành `['1.4.3','1.4.7','1.4.8','1.4.9']`.
  1.4.8 vốn đã có một lần `npm run test:live` đầy đủ (mục 6.3); 1.4.9 tính tới đợt 7 mới có một task lẻ nên chưa được
  thêm — đợt này chạy lại đủ `test:live` trên đúng CLI 1.4.9 rồi mới thêm, đúng chuẩn đã ghi.
- Pool id trong `priority`: hoặc cho nó thật (default agent = pool), hoặc cảnh báo khi cấu hình như vậy.

Quy tắc cho người tiếp theo:

- **Đo argv của process con, đừng suy từ schema.** Bốn cờ thiếu không hiện ra ở bất kỳ lỗi nào, không hiện trong
  `delegateSchema`/`agentProfileSchema`; chỉ argv nói thật.
- Fake CLI trên Windows phải là `.cmd` có `%~dp0\entry.js` (regex `SHIM_ENTRY`, `process.ts:42`); đường dẫn `.js` tuyệt đối
  bị `resolveCommand` từ chối thẳng (`:36`, "a native .exe or an npm .cmd shim …").
- Probe ghi owner settings (`model.json`, `permissions.json`, `soft-timeout.json`) thì set **`BRIDGE_HOME`** (bắt buộc absolute)
  trỏ vào scratch: không set thì chúng rơi vào `.bridge-state` của worktree và đổi hành vi mọi lần chạy sau từ checkout đó.
- **Đừng `git checkout --` một bản sửa chưa commit** rồi tưởng nó vẫn còn. Lần mutation-test đầu tiên của đợt này bị hỏng
  vì thế: `git checkout` kéo file về bản lỗi, nên hai variant sau đỏ ở assertion *đầu tiên* chứ không phải assertion đang
  định test. Save bản đã sửa ra `/tmp` rồi restore từ đó, và kiểm `git diff --stat` trước khi kết luận.

Bằng chứng chạy trên **đúng nội dung cuối** (`README.md` +12/−1, `docs/HANDOFF.md` +72 kể cả block này, guard 24 dòng,
config mẫu 1 dòng đổi):

- Windows, Node **24.15.0**: **262 test / 256 pass / 0 fail / 6 skipped**, 330,7 s, exit 0. So với baseline của `0.1.24`
  (261/255/0/6) là **+1 test** — đúng guard mới; số skip không đổi (năm test nhóm POSIX signal + `cli: --open`).
- **Linux không chạy local đợt này**: bản sửa chỉ là config mẫu (tài liệu trong tarball) + guard chỉ parse JSON + markdown,
  không có đường nào phân nhánh theo nền tảng. Hai job `test (ubuntu-latest, …)` trong CI là verdict Linux thật, và
  `tests/package.test.ts` vẫn chặn việc đưa `docs/HANDOFF.md` vào tarball.
- Suite được khởi động **trước** khi tôi sửa ba câu markdown cuối. Điều đó không làm mất giá trị run: phép kiểm
  `grep -rn "README\|HANDOFF" tests/*.ts` chỉ ra đúng một file tham chiếu là `tests/package.test.ts`, và cả hai chỗ
  (`:33`, `:44`) chỉ kiểm **tên file trong tarball**, không đọc nội dung. TS và config JSON thì đã ở bản cuối trước `tsc`.


### 6.9 Đợt 7 — 2026-10-28: profile `antigravity` nhận đủ setting của chủ máy (marker "họ adapter")

Chủ máy đã duyệt hệ quả mở rộng quyền ghi ở mục 6.8, nên bản sửa chỉ làm đúng một việc: thêm `family` vào `AgentAdapter`
(`agents/types.ts`, giá trị `antigravity` / `codex`, do chính adapter khai báo) và đổi hai phép so sánh trong `manager.ts`
(`:249` chỗ ghi model vào request, `:354` chỗ quyết định cờ quyền / effort / log-file / print-timeout / transport)
từ `adapter.id` sang `adapter.family`. `registry.ts` không phải sửa: `antigravityAdapter()` sinh cả bản id gốc lẫn bản profile,
nên family luôn đi đúng CLI thật kể cả khi profile trỏ `executable` tới một shim khác.

Bằng chứng, đo chứ không suy:

| Kiểm | Cách đo | Kết quả |
|---|---|---|
| argv của profile đúng bằng argv của agent gốc | test mới `an antigravity profile is launched with the owner model, permission level, effort, soft deadline and log file`: ghi owner settings (`gemini-3-pro-high`, `accept-edits`, effort `high`, soft deadline 7200 s) vào state scratch, chạy `antigravity` rồi profile `agy-team` trên cùng CLI giả, so argv sau khi bỏ hai phần luôn khác theo task (prompt và tên log) | **Xanh**; cả hai argv đều có `--model/--mode/--effort/--print-timeout 7200s/--log-file` |
| Bỏ fix ở `manager.ts:354` (đổi `family` về `id`) | giữ nguyên bản đã sửa trong `/tmp`, patch rồi restore từ đó (đúng quy tắc đợt 6) | **Đỏ** ở `agy-team gets the model chosen in the web UI` |
| Bỏ fix ở `manager.ts:249` | như trên, chỉ đổi chỗ ghi model vào request | **Đỏ** cùng assertion — `:249` chính là nguồn của `--model`, nên hai chỗ này là một chuỗi nhân quả, không phải hai lỗi rời |
| Stream transport | bật step progress rồi chạy lại cả hai id trong cùng test | **Xanh**: cả hai đều là `--output-format stream-json` |
| Family đặt sai trên adapter | test `an antigravity profile keeps the adapter family its owner settings belong to` đọc `createAgentRegistry` với một profile antigravity + một profile codex | **Xanh**, và đỏ ngay khi `family` của một adapter bị khai sai |
| CLI thật, không phải mock | probe `test-results/live-profile-argv.mjs` (scratch gitignored, **không commit**): bridge thật với `BRIDGE_HOME` trỏ vào `%TEMP%\agy-profile-live-…`, config chỉ có `antigravity` + profile `agy-team`, delegate qua đúng MCP tool, argv đo ở ranh giới CLI nhờ `executable` của profile là wrapper `.cmd` → `agyw.js` ghi argv rồi spawn `agy.exe` | argv thật của task profile: `--output-format json --print-timeout 120s --disable-slash-commands --model gemini-3.8-flash-low --mode accept-edits`; task `completed`, exit 0, `agent: agy-team`, sentinel `UNCHANGED`, verdict `LIVE PROFILE ARGV OK` trên **agy 1.4.9** |

Vài thứ chỉ ra khi đo, không có cách nào khác để biết:

- **Một wrapper `.cmd` tự ghi log sẽ bị bỏ qua hoàn toàn.** `resolveCommand` (`process.ts:33`) thấy `.cmd` là thay nó bằng
  `node.exe` + entry `.js` khớp `SHIM_ENTRY`, nên lệnh trong wrapper không bao giờ chạy. Muốn đo argv thì wrapper phải là
  `.cmd` trỏ tới một `.js` của mình, và `.js` đó spawn CLI thật.
- **`agy` trên máy này là native exe**, không phải shim npm: `%LOCALAPPDATA%\agy\bin\agy.exe` → `prefixArgs` rỗng.
  `agy models` hiện trả sáu id (`gemini-3.8-flash-{high,medium,low}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`,
  `gpt-oss-120b-medium`), tức là họ model đã đổi so với các đợt trước — `VERIFIED_AGY_VERSIONS` đã cập nhật ở mục 6.10,
  còn họ model thì chưa có test nào khóa tên id cụ thể. (2026-10-31: không thêm — `tests/models.test.ts` đã ghim cách parse
  trên một mẫu `agy models`, còn việc "id này có thật" chỉ kiểm được bằng `agy models` sau khi đăng nhập, mà lần thử hôm
  nay `agy` báo `Please sign in to view available models`. Một test đơn vị không phát hiện được CLI đổi họ model.)
- **Test argv phải tự xóa `BRIDGE_AGY_PERMISSIONS`.** `permissionState` đọc env trước file, nên nếu shell của người chạy để
  leftover một mức nào đó thì argv trong test do env quyết định, không phải do đoạn code đang bị test.

Hệ quả an toàn, đã viết lại trong README mục "Agents, profiles and pools": `--mode` giờ tới được task chạy profile, nghĩa là
mức `full` của chủ máy sinh `--dangerously-skip-permissions` cho cả task profile. Trước bản sửa, profile bị khóa ở mặc định của
CLI và đó là con đường duy nhất để cờ đó không tới. Profile `antigravity` vì thế **không còn "an toàn hơn theo mặc định"**:
nó an toàn đúng bằng mức chủ máy đặt trong Settings.
Vẫn còn một khoảng cách chưa nhân tiện sửa: field `model` trên profile antigravity vẫn bị bỏ qua (chỉ profile codex đọc nó),
vì model của antigravity lấy từ web UI, không từ config.

Bằng chứng run trên đúng nội dung cuối:

- Windows, Node **24.15.0**: **264 test / 258 pass / 0 fail / 6 skipped**, 275,7 s, exit 0. So với baseline `0.1.25`
  (262/256/0/6) là **+2 test** — đúng hai test mới của đợt này; số skip không đổi.
- **Linux không chạy local**: thay đổi chỉ là một field trên interface và hai phép so sánh chuỗi, không có nhánh nào theo
  platform hay filesystem. Hai job `test (ubuntu-latest, …)` trong CI là verdict Linux thật.
- `skills/` không đổi nên không phải đăng ký hash mới (`known-versions.json`); `tests/package.test.ts` vẫn chặn
  `docs/HANDOFF.md` trong tarball, và block markdown này không đổi hành vi runtime.

### 6.10 Đợt 8 — 2026-10-28: `VERIFIED_AGY_VERSIONS` thêm 1.4.8 và 1.4.9, bằng chứng là một lần `test:live` đầy đủ

`process.ts:9` từ `['1.4.3','1.4.7']` thành `['1.4.3','1.4.7','1.4.8','1.4.9']`. Không có logic nào đổi: danh sách này
quyết hai thứ — `warnings` của `inspectCli` (`process.ts:139`) và câu trong `limitations` (`runtime.ts:76`), cả hai đều
suy ra từ constant.

**Vì sao phải đo thêm chứ không tin bằng chứng cũ:** chuẩn của tài liệu này (mục 6.8) là **cả** `npm run test:live`
(smoke + cancel + shutdown), không phải một task `completed`. 1.4.8 đã đạt chuẩn đó từ đợt nghiệm thu nhánh
`antigravity` (mục 6.3) nên chỉ cần ghi lại nguồn. 1.4.9 thì đợt 7 mới có một task chui qua đường pool — chưa đủ, nên
trước khi thêm phải chạy lại toàn bộ live script trên đúng CLI máy này (`agy --version` = **1.4.9**).

| Cái đo | Kết quả trên CLI thật |
| --- | --- |
| `node dist/scripts/live.js` với **1.4.9**, chạy trên `main` `17209c3` (code **chưa** sửa, để lấy chính cái cảnh báo cũ) | **exit 0**, `success: true`, 08:59:49,181Z → 09:00:59,903Z (70,7 s, sáu task thật, một bị hủy ngay). Smoke `completed` exit 0 `BRIDGE_SMOKE_OK`; `response_verified` + `workspace_unchanged` (sentinel `UNCHANGED`, thư mục chỉ còn `sentinel.txt`); `reconnected: true`; mission `a/b/c` đều `completed`, `progress {3,3,0,0,0,0}`, `plan_steps 3`; cancel `canceled` exit 1, `process_running: false`, `denied_actions: []`; `server_exit_code: 0`, `shutdown_with_active_task_verified: true`. Boot log ghi nguyên văn `only 1.4.3 and 1.4.7 have been verified` — tức trước bản sửa, CLI 1.4.9 vẫn chạy được nhưng bị đánh dấu chưa xác minh |
| `inspectCli` trên đúng `agy` sau khi sửa | `version 1.4.9, supported: true, warnings: []`; `VERIFIED_AGY_VERSIONS` đọc ra `["1.4.3","1.4.7","1.4.8","1.4.9"]`. `agy` máy này là native exe (`%LOCALAPPDATA%\agy\bin\agy.exe`, `prefixArgs` rỗng) |
| Regression test | Thêm hai dòng `['1.4.8','',true,false]` và `['1.4.9','',true,false]` vào bảng `CLI accepts the 1.4 patch family…`. Phá constant về `['1.4.3','1.4.7']` rồi build lại → **đỏ** ngay test đó; khôi phục → xanh. Hai dòng `1.4.0`/`1.4.99` vẫn `warn=true`, chứng minh thêm danh sách không biến cảnh báo thành vô điều kiện |
| Suite Windows (Node 24.15.0) | **264 test / 258 pass / 0 fail / 6 skipped**, 4 m 37 s, exit 0. Số test bằng baseline `0.1.26` vì đợt này chỉ thêm hai dòng vào bảng có sẵn, không thêm test mới |

**Chưa tuyên bố gì:** danh sách là **kết quả đo trên máy phát triển**, không phải cam kết mọi bản 1.4.8/1.4.9 ở máy khác
đều giống nhau; 1.4.x patch khác (1.4.0, 1.4.10…) vẫn chỉ được họ version + cờ help duyệt, vẫn cảnh báo. Phần stdin của
mục 8 HARDENING không đổi — live script dùng transport argv mặc định, nên chạy thêm patch cũng không chứng minh được stdin.
Họ model đã đổi (`agy models` trả sáu id khác các đợt trước) nhưng không có test nào khóa tên model id, nên đợt này không đụng.

**Linux:** không chạy local — thay đổi chỉ là một mảng hằng + tài liệu, không có nhánh platform nào; hai job
`test (ubuntu-latest, …)` là verdict Linux thật. `skills/` và `config/` không đổi nên không phải đăng ký hash skill.
