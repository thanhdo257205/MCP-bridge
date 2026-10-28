# Kế hoạch Tích hợp XERJ vào MCP-Bridge (Reference Coding & Code Search)

## 1. Bối cảnh & Mục tiêu

- **XERJ** (`tools/xerj/xerj.exe`) là search engine tốc độ cao viết bằng Rust cho AI coding agent, tương thích giao thức Elasticsearch HTTP (`localhost:9200`), hỗ trợ tree-sitter AST symbol indexing và passage-level extraction.
- **Dữ liệu hiện có**: Thư mục `tools/xerj/` và index `mcp-bridge-docs` (749 docs, 5.3MB) đã được tải về và index sẵn trong `tools/xerj-data/` bởi agent trước.
- **Mặc định tắt (opt-in)** ở bản phát hành: bật tính năng nghĩa là gửi nội dung `task` cho một dịch vụ local khác và ghép passage lấy được vào prompt mà agent phải tuân theo — nên `xerj.enabled` và `xerj.auto_reference` đều `default(false)`, `code_search` luôn nằm trên surface nhưng từ chối khi chưa bật, và hai route `/api/xerj/*` không forward query khi chưa bật.
- **Mục tiêu**:
  1. Xây dựng module client `src/xerj/client.ts` kết nối với XERJ API (ES-compatible `_search` với `_passage` field và defs matching).
  2. Tạo MCP Tool `code_search` cho Tech Lead / Developer agents (Antigravity, Codex) để truy vấn nhanh định nghĩa và đoạn mã liên quan mà không phải đọc toàn bộ file.
  3. Tính năng **Auto Reference Coding**: Khi bridge giao việc qua `start_task`, chỉ khi chủ máy bật **cả hai** cờ `xerj.enabled` và `xerj.auto_reference`, bridge trích xuất các code passage liên quan nhất và gắn vào prompt giao việc làm context tham khảo (giúp giảm 2.7x - 5x tokens cho agent).
  4. Cung cấp API endpoint `/api/xerj/status` và `/api/xerj/search` để Web UI và HTTP client có thể sử dụng.
  5. Đảm bảo fallback an toàn (graceful degradation): Nếu daemon XERJ không chạy, bridge vẫn hoạt động bình thường 100%, không báo lỗi sập hệ thống.

---

## 2. Kiến trúc & Các thành phần

```
┌─────────────────────────────────────────────────────────────────┐
│                          MCP-Bridge                             │
│                                                                 │
│  ┌───────────────────────┐            ┌──────────────────────┐  │
│  │   MCP Tool            │            │  TaskManager         │  │
│  │   `code_search`       │            │  (auto_reference)    │  │
│  └───────────┬───────────┘            └──────────┬───────────┘  │
│              │                                   │              │
│              └───────────────┬───────────────────┘              │
│                              ▼                                  │
│                   ┌───────────────────────┐                     │
│                   │      XerjClient       │                     │
│                   │  (src/xerj/client.ts) │                     │
│                   └──────────┬────────────┘                     │
└──────────────────────────────┼──────────────────────────────────┘
                               │ HTTP / JSON
                               ▼
            ┌──────────────────────────────────────┐
            │  XERJ Engine (localhost:9200)        │
            │  tools/xerj/xerj.exe                 │
            │  - AST symbols & defs                │
            │  - `_passage` extraction             │
            │  - Index: mcp-bridge-docs            │
            └──────────────────────────────────────┘
```

---

## 3. Chi tiết thực hiện

### 3.1. Client Module (`src/xerj/client.ts`)
- Config: `XERJ_URL` (default: `http://127.0.0.1:9200`) hoặc config `xerj.url`.
- `isAvailable()`: kiểm tra server có đang phản hồi không (với timeout ngắn 500ms).
- `search(query: string, options?: { limit?: number; index?: string })`:
  - Gửi request đến `POST /<index>/_search`:
    ```json
    {
      "query": {
        "bool": {
          "should": [
            { "multi_match": { "query": query, "fields": ["body", "defs"], "type": "most_fields" } },
            { "match_phrase": { "defs": { "query": query, "boost": 4 } } }
          ]
        }
      },
      "_source": ["ax_path", "title"],
      "fields": ["_passage"],
      "size": limit
    }
    ```
  - Parse hits thành danh sách:
    ```ts
    export interface XerjPassage {
      field: string;
      text: string;
      start_offset?: number;
      end_offset?: number;
    }
    export interface XerjHit {
      file: string;
      title: string;
      score: number;
      passage?: string;
    }
    ```
- `formatPassagesForPrompt(hits: XerjHit[]): string`: định dạng gọn gàng các passage để inject vào prompt giao việc.

### 3.2. Cấu hình (`src/config.ts`)
- Thêm `xerjSchema`:
  ```ts
  xerj: z.object({
    enabled: z.boolean().default(false),
    url: z.string().default('http://127.0.0.1:9200'),
    default_index: z.string().default('mcp-bridge-docs'),
    auto_reference: z.boolean().default(false),
    max_passages: z.number().default(3),
  }).default({})
  ```

### 3.3. Đăng ký Tool (`src/tools/register.ts`)
- Thêm tool `code_search`:
  - `query` (string, required): từ khóa tìm kiếm (tên hàm, class, chức năng...).
  - `limit` (number, optional, default: 5): số lượng kết quả.
  - Kết quả trả về: Danh sách các code passage kèm đường dẫn file và điểm số liên quan.

### 3.4. Auto Reference trong Task Delegation (`src/tasks/manager.ts`)
- Khi `start_task` được gọi:
  - Kiểm tra `xerj.enabled && xerj.auto_reference`; thiếu một trong hai thì không gọi index và không gắn passage.
  - Lấy query trích xuất từ `input.task` (hoặc `input.task` trực tiếp nếu ngắn).
  - Tìm kiếm các passage hàng đầu (score > ngưỡng tối thiểu).
  - Nếu có kết quả, chèn đoạn:
    ```
    Reference context from codebase (via XERJ):
    --- File: src/budget.ts ---
    export async function budgetState(...) { ... }
    ---------------------------
    ```
    vào prompt mà bridge gửi cho agent thực hiện.

### 3.5. HTTP Bridge Endpoints (`src/http.ts`)
- `GET /api/xerj/status`: trả về trạng thái server XERJ và danh sách indices.
- `GET /api/xerj/search?q=...`: tìm kiếm trực tiếp cho Web UI hoặc công cụ bên ngoài.

---

## 4. Kế hoạch Kiểm thử & Xác minh

1. **Unit tests (`tests/xerj.test.ts`)**:
   - Test kết nối XERJ client khi server online vs offline (fallback graceful).
   - Test định dạng query JSON ES-compat.
   - Test trích xuất hit và `_passage`.
   - Test format passage cho reference coding prompt.
2. **Integration tests**:
   - Test tool `code_search` qua MCP tool register.
   - Test task delegation có đính kèm auto-reference.
3. **Full test suite regression**:
   - Đảm bảo toàn bộ test suite tiếp tục pass.
