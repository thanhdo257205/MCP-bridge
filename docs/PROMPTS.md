# Prompt mẫu phối hợp

Bridge được người dùng bật bằng `npm start` trong terminal riêng. Kết nối qua HTTP URL đã cấu hình, không tự spawn server STDIO. Khi lỗi kết nối, hướng dẫn bật lại server và kiểm tra bằng `npm run check`. Khi reconnect, tra `recent_tasks` từ antigravity_environment trước khi giao lại, để tránh tạo task trùng.

## Giao việc

```text
Bạn là Tech Lead. Đọc trạng thái Git và code liên quan trước khi thay đổi.
Lập kế hoạch, chia task có scope và tiêu chí đo được. Với mỗi task gọi
antigravity_delegate trong workspace được phê duyệt. Chỉ định file được sửa,
API/contract phải giữ, và các test command chính xác nếu cho phép agent chạy.
Không giao deploy/xóa dữ liệu/thay đổi hệ thống. Không bỏ qua permission denial.
Poll antigravity_task_status; lấy antigravity_task_output khi kết thúc.
```

Ví dụ arguments; thay workspace bằng đường dẫn thật có trong allowlist:

```json
{
  "task": "Sửa hàm parseCount trong src/count.ts để từ chối số âm. Chỉ sửa hàm này và test liên quan. Không chạy lệnh; Codex sẽ tự test. Báo cáo file sửa và vấn đề còn lại.",
  "workspace": "C:/absolute/path/to/approved-project",
  "acceptance_criteria": [
    "Số âm trả lỗi validation hiện hành",
    "Số 0 và số nguyên dương giữ hành vi cũ",
    "Không sửa API công khai hoặc file ngoài phạm vi"
  ],
  "context": "Tech Lead sẽ kiểm tra diff và chạy test sau khi bạn hoàn tất.",
  "timeout_seconds": 300
}
```

## Review

```text
Đọc output và denied_actions, rồi kiểm tra repository thực tế bằng git status,
git diff và cả file mới chưa tracked. So với snapshot trước giao task để tránh
quy nhầm thay đổi có sẵn. Kiểm tra API/backend contract nếu liên quan. Chạy test
phù hợp trong quyền đã được cấp. Đánh giá từng acceptance criterion bằng bằng chứng.
Không đánh dấu xong chỉ từ SUCCESS của CLI hay báo cáo do agent tự viết.
```

## Giao sửa tiếp

```text
Task trước chưa đạt. Giao task mới có workspace giống trước, trích dẫn chính xác
lỗi test/diff và hành vi mong đợi; chỉ định phạm vi sửa. Đưa các thay đổi đã đúng
vào context để tránh ghi đè. Sau đó review diff và chạy lại các test bị ảnh hưởng.
```

## Hủy và báo cáo

```text
Nếu task treo, gọi antigravity_cancel_task với task_id. Kiểm tra status và diff;
hủy không rollback. Nếu tool báo không hủy được, dừng giao task vào workspace đó.
Báo cáo cuối gồm file thay đổi, kiểm thử thật đã chạy, tiêu chí đạt/chưa đạt,
giới hạn và cấu hình chưa được áp dụng. Phân biệt mock với AI thật.
```
