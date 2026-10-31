# Tích hợp Freebuff CLI — đo lường, quyết định, và phần đã làm

Trạng thái: quyết định đã chốt, chiều **client** đã triển khai (2026-10-31). Chiều **worker** bị từ chối có lý do,
kèm điều kiện mở lại. Cập nhật: 2026-10-31.

## 0. Kết luận trước

| Câu hỏi | Trả lời | Căn cứ |
|---|---|---|
| Freebuff CLI có dùng được làm **worker** (được `antigravity_delegate` giao việc) không? | **Không.** CLI chỉ có TUI tương tác; không có `--print`/`-p`, `--headless`, `--json`, không nhận prompt dạng tham số, không đọc prompt từ stdin | §2.1 (đo), §3.1 (quyết định) |
| Freebuff CLI có dùng được làm **client/orchestrator** (gọi bridge) không? | **Có.** Nó là MCP client, đọc `mcpServers` từ `.agents/mcp.json` / `~/.agents/mcp.json`. Đã thêm `setup freebuff` (+ `--apply`) | §2.2, §4 |
| Cần sửa gì trong bridge để "tích hợp Freebuff"? | Chỉ chiều client: in/ghi một entry stdio. **Không** thêm adapter, không thêm `adapter` id mới | §4 |

Nói ngắn: bridge **không nhận** Freebuff làm Developer, nhưng **được điều khiển bởi** Freebuff.

## 1. Bối cảnh

Bridge có hai chiều, và chúng không đối xứng:

- **Chiều worker**: bridge spawn một CLI agent (`antigravity`, `codex`) và đọc kết quả có cấu trúc
  (`AgentAdapter.buildInvocation` + `parseResult`, `src/agents/types.ts`). Đây là thứ quyết định một CLI có
  trở thành `agent` id hay không.
- **Chiều client**: bất kỳ MCP client nào nói được Streamable HTTP hoặc stdio đều cầm được 14 tool
  (`src/tools/register.ts`), không cần bridge biết nó là ai.

Freebuff là bản **miễn phí, có quảng cáo** của Codebuff (`npm i -g freebuff`; package chỉ là launcher tải binary
native về `~/.config/manicode/freebuff`). Vì vậy câu "tích hợp Freebuff" phải tách làm hai, và câu trả lời khác nhau.

## 2. Đo lường

### 2.1 Chiều worker — đã đo, kết quả âm

| Bằng chứng | Nội dung | Độ tin |
|---|---|---|
| Issue `CodebuffAI/freebuff#947` (mở 2026-08-06, còn mở, nhãn `area:cli`, `type:feature`) | Trên `freebuff v0.0.140`: `freebuff -p` → `error: unknown option '-p'`; `freebuff --headless` → `error: unknown option '--headless'`; `freebuff --json` → `error: unknown option '--json'`; `freebuff "do something"` → không nhận tham số `[prompt...]` (chỉ có `[command]` với `choices: ["login"]`); prompt qua stdin → **treo chờ TTY**. Kết luận của issue: "the freebuff CLI is purely interactive — a TUI with no headless path" | Cao: lệnh + thông báo lỗi cụ thể, có version |
| Blog chính thức freebuff.com (2026-10-13) | "The CLI is an interactive terminal UI. There is no headless or CI mode, so scripted pipelines are out of scope for now." | Cao: nguồn của nhà sản xuất |
| Cùng issue, phần Codebuff trả phí | `codebuff` CLI có thêm `--agent`, `--max`, `--plan`, `[prompt...]` nhưng **cũng không** có `--print`/`--json`. Đường headless duy nhất là `@codebuff/sdk` `CodebuffClient.run()` với `CODEBUFF_API_KEY` (`cb_…`) — khoá trả phí, **không** phải token device-OAuth mà Freebuff lưu ở `~/.config/manicode/credentials.json` | Cao |
| Issue nói thêm | Freebuff/Codebuff là **MCP client**, không phải MCP server, nên MCP cũng không phải đường để điều khiển nó như một provider | Cao (khớp với §2.2) |

Chưa đo được trên máy này: Freebuff CLI **không có trên PATH** (`where freebuff` rỗng; `%LOCALAPPDATA%\Freebuff`
chỉ có `install-receipt.txt`, không có binary). Nên các lệnh trên là đọc từ nguồn, không phải chạy lại tại chỗ.
Việc này **không** đổi quyết định, vì bản thân nhà sản xuất cũng nói không có headless mode; nhưng nó có nghĩa:
khi Freebuff được cài lên máy chủ bridge, phải đo lại trước khi tin bất cứ dòng nào ở §2.1.

### 2.2 Chiều client — đã đo qua ba nguồn độc lập

| Bằng chứng | Nội dung |
|---|---|
| `akitaonrails/ai-memory` → `docs/mcp-install.md` | "FreeBuff reads `mcpServers` from `.agents/mcp.json` while walking from the current directory toward the home directory." Installer của họ merge một entry **stdio** vào `~/.agents/mcp.json`. |
| `ihateposting.com` → bảng MCP client | "Freebuff CLI — `~/.agents/mcp.json` hoặc `.agents/mcp.json` — key `mcpServers`" |
| `lobehub.com` / `mcpservers.org` (playwright-e2e-mcp) | Repo ship sẵn `.agents/mcp.json` để "opening the checkout in Freebuff attaches the server workspace-wide" |

Suy ra (chưa phải schema chính thức): `{"mcpServers": {"<name>": {"command": "...", "args": [...]}}}` — shape
stdio quen thuộc, đúng như installer của ai-memory ghi. Bridge dùng shape này và **không** ghi gì khác.

**Chưa đo**: (a) Freebuff có nhận entry transport `http`/`url` trong `mcp.json` hay chỉ `command`; (b) Freebuff có
đọc skill trong `~/.agents/skills` như Codex hay không; (c) thứ tự gộp khi cả `.agents/mcp.json` (project) và
`~/.agents/mcp.json` cùng tồn tại. Cả ba đều **không** được tài liệu hoá bởi nhà sản xuất, nên bridge không dựa
vào chúng: nó ghi đúng một entry stdio và nói rõ giới hạn đó cho người dùng.

## 3. Quyết định

### D1 — Không viết adapter `freebuff` (chiều worker)

Một adapter trung thực phải làm được hai việc, và Freebuff không làm được việc nào:

1. **Khởi chạy không tương tác** — bridge spawn tiến trình với `stdio: pipe` và không có TTY nào
   (`src/antigravity/process.ts`). Một TUI cần TTY sẽ treo hoặc thoát ngay; đúng như issue ghi: stdin → "hangs
   waiting for a TTY".
2. **Trả kết quả máy đọc được** — `parseResult` phải phân biệt được `completed` với "CLI chạy xong nhưng không
   chứng minh gì", kể cả `denied_actions` và timeout (`src/agents/antigravity.ts`, `src/agents/codex.ts`). Không
   có JSON/JSONL thì chỉ còn cách bóc ANSI khỏi màn hình TUI.

Đường "bóc TUI" bị loại vì nó phá đúng bất biến mà dự án đã trả giá để giữ: `review_required: true` và
`acceptance_verified: false` chỉ có nghĩa nếu `success` **không** bị đoán. Một adapter scrape TUI sẽ phải bịa
`success` từ việc "có chữ nào đó xuất hiện trên màn hình", tức là biến bridge thành máy tạo false-positive —
ngược hẳn với `docs/HARDENING.md` và toàn bộ phần "CLI SUCCESS/exit 0 không chứng minh acceptance" trong README.

**Điều kiện mở lại (đúng hai, không phải "khi nào rảnh"):**

- Freebuff CLI ra `--print`/`-p` với một event stream ổn định (`--output-format stream-json`, giống đề xuất
  Option A trong issue #947); hoặc
- `@codebuff/sdk` chấp nhận token device-OAuth của Freebuff (Option B), khi đó bridge gọi SDK thay vì CLI —
  nhưng như vậy nó là một *thư viện*, không phải CLI, và `AgentRuntime.launch` hiện chỉ nhận tiến trình.

Khi một trong hai xảy ra, adapter viết theo đúng khuôn `src/agents/codex.ts` (JSONL trên stdout + `resultFile`
cho tin nhắn cuối), thêm `family: 'freebuff'` vào `AgentFamily`, thêm vào `KNOWN` và enum trong
`src/config.ts`, và phải có fixture giả trong `tests/fixtures/` trước khi chạm tới CLI thật.

### D2 — Tích hợp chiều client (đã làm)

`agy-mcp-bridge setup freebuff` in ra entry cần dán; `setup freebuff --apply` ghi nó vào
`~/.agents/mcp.json` (hoặc `.agents/mcp.json` của project với `--project <dir>`), sau khi in diff và hỏi, có
backup, ghi atomic. Không có đường nào khác bị sửa: entry khác trong `mcpServers` được giữ nguyên từng byte.

### D3 — stdio, không phải HTTP

Chỉ stdio là thứ có bằng chứng ở §2.2. In một entry `{"type":"http","url":...}` mà chưa ai xác nhận Freebuff hiểu
là đúng loại "bịa hợp đồng" mà tài liệu này vừa từ chối ở D1. Nếu về sau đo được HTTP, thêm nó như một lựa chọn
**thứ hai** chứ không thay stdio.

## 4. Hệ quả phải biết của stdio (khác hẳn HTTP)

Đây là chỗ dễ hiểu sai nhất, nên nói thẳng:

| | HTTP (`codex`, `claude`) | stdio (Freebuff) |
|---|---|---|
| Tiến trình bridge | Do **bạn** chạy (`agy-mcp-bridge`), sống độc lập | Là **process con** của Freebuff, do Freebuff spawn |
| Đóng client | Task đang chạy **tiếp tục**; kết nối lại đọc `recent_tasks` | `stdin` nhận EOF → `src/stdio.ts` gọi `manager.shutdown()` → **task đang chạy bị cancel**, cây tiến trình được reap |
| Nhiều client cùng lúc | Có (một TaskManager chung) | Không: một bridge cho mỗi phiên Freebuff |
| `tool_timeout` của client | Phải > `max_wait_seconds` (mặc định 55 s) | Vẫn áp dụng: một `antigravity_task_wait` bị client cắt thì task **không** bị cancel, chỉ là mất lượt chờ |
| Web UI | Có, ở cổng của server | **Không**, trừ khi bạn tự chạy thêm server HTTP (state dùng chung `.bridge-state`, nhưng hai tiến trình không chia sẻ TaskManager) |

Kết luận thực dụng: stdio phù hợp để Freebuff **điều khiển** các task ngắn; nó không phù hợp nếu bạn muốn task
sống qua việc đóng Freebuff. Muốn cả hai thì chạy server HTTP như bình thường và (nếu Freebuff hỗ trợ) trỏ nó vào
`http://127.0.0.1:3000/mcp` — phần này **chưa được đo** (§2.2).

## 5. Đã triển khai

| # | File | Nội dung |
|---|---|---|
| 1 | `src/setup.ts` | `Client` có thêm `'freebuff'`; `renderSetup` in khối `.agents/mcp.json` (stdio, đường dẫn tuyệt đối) + giải thích ngắn về vòng đời stdio và việc `--apply` ghi file nào |
| 2 | `src/freebuff-config.ts` (mới) | `freebuffConfigPath({project?, home?})`, `planFreebuffConfig(existing, {command, args})`, `writeFreebuffConfig(file, plan)`. Merge **chỉ** key `mcpServers.antigravity`, giữ nguyên phần còn lại; backup `.bak-<timestamp>` trước khi ghi; atomic qua `.tmp` + `rename`; từ chối (không đoán) khi JSON hỏng, root không phải object, `mcpServers` không phải object |
| 3 | `src/cli.ts` | `setup freebuff` in; `setup freebuff --apply [--project <dir>] [--yes]` ghi; help cập nhật |
| 4 | `README.md`, tài liệu này | Nói rõ Freebuff là **client**, không phải agent, kèm lý do một dòng và liên kết |

Skill: bridge **không** thêm `skill install --client freebuff`. Lý do: `.agents/skills` là nơi `--client codex`
đã ghi, nhưng chưa có bằng chứng Freebuff đọc thư mục đó (§2.2 c). `setup freebuff` in ra gợi ý
`skill install --client codex` kèm câu "chưa xác minh Freebuff có nạp skill từ đây hay không" thay vì hứa hão.

## 6. Tiêu chí nghiệm thu

| Hành vi | Test |
|---|---|
| `renderSetup` có `freebuff` in entry stdio, đường dẫn tuyệt đối, và **không** in `cli`/`claude` | `tests/setup.test.ts` |
| `planFreebuffConfig` tạo file mới khi chưa có | `tests/freebuff-config.test.ts` |
| Merge giữ nguyên mọi server khác, chỉ thêm/sửa `antigravity` | `tests/freebuff-config.test.ts` |
| Entry đã đúng → `none`, không ghi gì | `tests/freebuff-config.test.ts` |
| JSON hỏng / root là array / `mcpServers` là string → `refuse`, file không bị chạm | `tests/freebuff-config.test.ts` |
| `--apply` tạo backup và ghi atomic; nội dung đọc lại đúng | `tests/freebuff-config.test.ts` |
| `setup freebuff` chạy được từ CLI và **không ghi** gì vào đĩa | `tests/freebuff-config.test.ts` |
| `setup freebuff --apply` không có TTY và không `--yes` → thoát 1, file không đổi | `tests/freebuff-config.test.ts` |

### 6.1 Bằng chứng đã chạy (Windows, Node 24, máy dev, 2026-10-31)

| Việc | Kết quả |
|---|---|
| **Artifact, không phải ý định**: `node test-results/freebuff-e2e.mjs` gọi `setup freebuff --apply --project <tmp> --yes`, đọc `.agents/mcp.json` vừa ghi, rồi spawn **chính** `command` + `args` đó với stdin/stdout pipe và không TTY | `initialize` → `{name: 'antigravity-mcp-bridge', version: '0.1.27'}`; `tools/list` → **14** tool; `antigravity_environment` → `transport: 'stdio'`; stdout chỉ có JSON-RPC, chẩn đoán nằm ở stderr |
| Test của đợt này: `node --test dist/tests/{freebuff-config,setup,wait-setting,codex-config}.test.js` | **23 test · 23 pass · 0 fail** |
| Toàn bộ suite: `npm test` (build + `node dist/scripts/run-tests.js`, `--test-concurrency=1`) | **275 test · 269 pass · 0 fail · 6 skipped**, 427,9 s, exit 0 |

Sáu dòng `# SKIP` đúng là năm test POSIX-only cộng `cli: --open …` (chỉ chạy trên Linux), như mọi lần chạy Windows
trước đây trong `docs/HANDOFF.md`.

Lần chạy đầy đủ **đầu tiên** có đúng một test đỏ, `quota retry shares the original deadline instead of renewing it`,
và nó **không** đến từ đợt này: file `dist/tests/failover-regression.test.js` là build output **mồ côi** — không còn
nguồn `tests/failover-regression.test.ts`, nên `tsc` không bao giờ ghi đè nó, trong khi `scripts/run-tests.ts` quét
mọi `*.test.js` trong `dist/tests`. Đã xóa cặp `.js`/`.js.map` đó (dist là output sinh ra, bị gitignore) rồi chạy
lại; 275 test ở trên là lần chạy sạch. Ghi lại ở đây vì nó giải thích con số, và vì bất kỳ ai đọc log cũ sẽ thấy
một test đỏ không tồn tại trong mã nguồn.

Kiểm lại độc lập (không cần Freebuff đã cài):

```bash
npm run build
node dist/src/cli.js setup freebuff                                          # in ra, không ghi gì
node dist/src/cli.js setup freebuff --apply --project ./some-project --yes   # ghi + backup
node test-results/freebuff-e2e.mjs                                          # chạy đúng entry vừa ghi
node --test dist/tests/freebuff-config.test.js
```

## 7. Rủi ro và việc còn mở

1. **Đường dẫn tuyệt đối trong entry**: `command` là `process.execPath`, `args[0]` là `<packageRoot>/dist/src/stdio.js`
   của **bản cài hiện tại**. Cài lại/nâng cấp (hoặc `npm i -g` đổi prefix) là entry trỏ sai → chạy lại
   `setup freebuff --apply`. Đây là lý do `setup` in ra, chứ không giấu.
2. **Schema của Freebuff không phải tài liệu chính thức** của nhà sản xuất (chỉ ba nguồn bên thứ ba). Nếu Freebuff
   đổi sang `.codebuff/mcp.json` hoặc sang key khác, `--apply` sẽ ghi đúng vào file bridge biết, và **không** phát
   hiện được việc client bỏ qua nó. Cách kiểm duy nhất: mở Freebuff trong project rồi hỏi nó gọi
   `antigravity_environment`.
3. **Chưa đo bản Freebuff thật trên máy này** (không có CLI). Mục §2.1 cần được chạy lại khi cài.
4. **Không có `--apply` cho Claude Code** (từ trước) và bây giờ **không** có cho `both`: `both` vẫn là Codex +
   Claude Code. Freebuff là target riêng, để không ai lỡ tay đổi nghĩa một lệnh đã có trong tài liệu.
5. **HTTP cho Freebuff**: chưa biết nó có nhận `url` không. Nếu có, đó là đường nên dùng, vì nó bỏ được toàn bộ
   bảng hệ quả ở §4. Đo trước, sửa sau.
