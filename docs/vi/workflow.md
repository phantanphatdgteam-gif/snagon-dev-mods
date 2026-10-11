# Quy trình làm việc: hai ví dụ minh họa

Quay lại [README](../../README.vi.md). Tra cứu tệp: [files.md](files.md). Chi tiết: [guide.md](../guide.md).

Các tên trong ví dụ đều có trong mod. Lệnh được gõ dưới dạng `/<name>` (hiển thị là `/snagon-dev-mods:<name>` khi tên trùng nhau). Skill do mô hình chọn khi phù hợp, hoặc bạn gõ `/<skill-name>`. Agent được dùng khi bạn yêu cầu ("use the planner agent") hoặc khi mô hình tự giao việc; tên đầy đủ là `snagon-dev-mods:<agent>`.

## Phần A: Từ ý tưởng đến kết quả

Dự án là `tiny-ledger`: một CLI theo dõi chi tiêu cá nhân viết bằng Python. Nó đọc các tệp CSV xuất từ ngân hàng và in tổng theo tháng.

```mermaid
flowchart TD
  P0["0 Cài đặt và thiết lập"] --> P1["1 Kiểm tra ý tưởng"]
  P1 --> P2["2 Tiêu chí và eval"]
  P2 --> P3["3 Thiết kế"]
  P3 --> P4["4 Kế hoạch"]
  P4 --> P5["5 Xây từng tính năng"]
  P5 --> P6["6 Kiểm chứng"]
  P6 --> P7["7 Phát hành"]
  P7 --> P8["8 Tài liệu"]
  P8 --> P9["9 Học và đo lường"]
  P5 -.->|tính năng tiếp theo, phiên mới| P5
```

Giữa các phiên, nhật ký, bản bàn giao và memory digest chuyển ngữ cảnh sang phiên sau, nên bạn không phải nhắc lại.

### Giai đoạn 0: Cài đặt và thiết lập

| | |
|---|---|
| Mục tiêu | Mod đã được cài và mọi phiên đều biết quy tắc của dự án |
| Bạn gõ | `/plugin install snagon-dev-mods --marketplace phantanphatdgteam-gif/snagon-dev-mods`, rồi `/snagon-setup`, rồi trả lời phần hỏi đáp |
| Harness làm | Xem qua dự án, hỏi tối đa 4 vòng câu hỏi, đưa ra bản nháp, chỉ ghi tệp sau khi bạn xác nhận, sao lưu mọi tệp có sẵn |
| Bạn nhận được | `CLAUDE.md` với quy tắc dự án (tiền dùng `Decimal`, không bao giờ đổi số tiền trong `data/`, các lệnh `make test`, `make lint`, `make typecheck`) và `.snagon/CLAUDE.md` với sở thích của bạn |

### Giai đoạn 1: Kiểm tra ý tưởng

| | |
|---|---|
| Mục tiêu | Quyết định xem công cụ có đáng xây không |
| Bạn gõ | "Use product-lens on this idea: a CLI that reads bank CSV exports and prints monthly totals", rồi `/plan-prd` |
| Harness làm | Skill `product-lens` kiểm tra lý do làm và đưa ra bản tóm tắt nên làm hay không. `/plan-prd` viết một PRD gọn, đặt vấn đề lên trước, rồi chuyển tiếp sang `/plan`. Nhật ký và bộ nhớ bắt đầu ghi các quyết định |
| Bạn nhận được | Một bản tóm tắt nên làm hay không và một PRD |

### Giai đoạn 2: Tiêu chí nghiệm thu và eval

| | |
|---|---|
| Mục tiêu | Nói rõ "xong" nghĩa là gì trước khi có bất kỳ dòng mã nào |
| Bạn gõ | "Use intent-driven-development for the monthly report", rồi "Use eval-harness to define the evals" |
| Harness làm | `intent-driven-development` biến thay đổi mơ hồ thành tiêu chí nghiệm thu kiểm chứng được. `eval-harness` định nghĩa các eval về khả năng và hồi quy trước khi viết mã |
| Bạn nhận được | Tiêu chí nghiệm thu và eval. Lưu các quyết định chính bằng `memory_save` (loại `decision`) |

### Giai đoạn 3: Thiết kế

| | |
|---|---|
| Mục tiêu | Chốt cấu trúc và những lựa chọn rủi ro |
| Bạn gõ | "Use the architect agent for the CSV parsing design", rồi "Write ADRs with architecture-decision-records for CSV parsing and money" |
| Harness làm | Agent `architect` đề xuất thiết kế. `architecture-decision-records` viết các ADR trong `docs/adr/` |
| Bạn nhận được | Một bản thiết kế và các ADR cho quyết định về phân tích CSV và về tiền |

### Giai đoạn 4: Kế hoạch

| | |
|---|---|
| Mục tiêu | Một kế hoạch từng bước mà bạn đã duyệt |
| Bạn gõ | `/plan`, rồi xác nhận |
| Harness làm | `/plan` (agent `planner`) nhắc lại yêu cầu, đánh giá rủi ro, viết kế hoạch từng bước và chờ bạn xác nhận trước khi đụng đến mã |
| Bạn nhận được | Một kế hoạch đã xác nhận. Chia công việc thành mỗi phiên một tính năng |

### Giai đoạn 5: Xây từng tính năng

| | |
|---|---|
| Mục tiêu | Một tính năng được xây theo hướng viết test trước |
| Bạn gõ | "Use tdd-workflow to build the monthly report". Khi build hỏng: `/build-fix`. Với câu hỏi bên lề: `/aside ...` |
| Harness làm | `tdd-workflow` (agent `tdd-guide`) dẫn dắt công việc viết test trước. Quy tắc đường dẫn cho Python tự nạp khi đụng đến tệp `.py`. Cổng yêu cầu nêu sự việc trước lần sửa đầu tiên của mỗi tệp, lệnh Bash đầu tiên và mỗi lệnh phá hủy. `/build-fix` sửa lỗi build và lỗi kiểu bằng những thay đổi tối thiểu. `/aside` trả lời mà không làm mất nhiệm vụ đang làm |
| Bạn nhận được | Mã chạy được kèm test, và một mục nhật ký cuối phiên |

### Giai đoạn 6: Kiểm chứng

| | |
|---|---|
| Mục tiêu | Biết tính năng đúng trước khi phát hành |
| Bạn gõ | "Run verification-loop", `/test-coverage`, `/code-review`, "Use the python-reviewer and security-reviewer agents", và `/santa-loop` cho đoạn mã xử lý tiền có rủi ro |
| Harness làm | `verification-loop` chạy build, kiểm tra kiểu, lint, test kèm độ phủ, grep bảo mật và rà soát diff, rồi báo PASS hoặc FAIL. `/test-coverage` tìm chỗ thiếu và viết các test còn thiếu. `/code-review` rà soát thay đổi cục bộ từng bước. `/santa-loop` dùng hai người rà soát độc lập, cả hai đều phải duyệt |
| Bạn nhận được | Một báo cáo PASS hoặc FAIL, các test bổ sung và kết quả rà soát |

### Giai đoạn 7: Phát hành

| | |
|---|---|
| Mục tiêu | Thay đổi đã được commit và nằm trong một pull request |
| Bạn gõ | `/prp-commit` (hoặc git thuần), rồi `/pr` |
| Harness làm | Git guard quét những gì commit hoặc push sẽ công bố để tìm bí mật và tệp riêng tư, và từ chối `--no-verify`. `/prp-commit` tạo commit từ một mô tả thông thường. `/pr` mở pull request trên GitHub |
| Bạn nhận được | Một commit và một pull request. Khi bị từ chối, thông báo nêu tên tệp và loại bí mật, không bao giờ nêu giá trị |

### Giai đoạn 8: Tài liệu

| | |
|---|---|
| Mục tiêu | Tài liệu khớp với mã |
| Bạn gõ | `/update-docs`, hoặc "Use the doc-updater agent" |
| Harness làm | `/update-docs` đồng bộ tài liệu từ các tệp nguồn |
| Bạn nhận được | README và tài liệu đã cập nhật |

### Giai đoạn 9: Học và đo lường

| | |
|---|---|
| Mục tiêu | Giữ lại điều bạn đã học và xem nó tốn bao nhiêu |
| Bạn gõ | `memory_save` cho phản hồi và bài học (nhờ Claude lưu), "Use continuous-learning-v2", `/learn`, `/cost-report` |
| Harness làm | `continuous-learning-v2` biến các lần chỉnh sửa, quyết định và bài học thành bộ nhớ dự án. `/learn` biến các mẫu của phiên thành một skill ứng viên. `/cost-report` tóm tắt `.snagon/cost.jsonl` |
| Bạn nhận được | Các mục bộ nhớ, một skill ứng viên và bản tóm tắt chi phí |

### Cách có kết quả tốt nhất với chi phí thấp nhất

Mọi mẹo dưới đây đều là thứ mod hoặc các skill của nó hỗ trợ.

- Chạy `/snagon-setup` trước, để mọi phiên biết quy tắc dự án mà không lặp lại những gì harness đã làm.
- Viết tiêu chí nghiệm thu và eval trước khi viết mã (`intent-driven-development`, `eval-harness`). Xác nhận `/plan` trước khi viết mã.
- Làm một tính năng hoặc một giai đoạn mỗi phiên. Kết thúc bằng một mục nhật ký (nhắc khi dừng sẽ yêu cầu). Bản bàn giao và bộ nhớ sẽ chuyển nó sang phiên sau.
- Tìm trong bộ nhớ (`memory_search`) trước khi quyết định lại. Lưu các chỉnh sửa và quyết định (`memory_save`).
- Nén ngữ cảnh ở ranh giới giữa các giai đoạn, sau khi viết nhật ký (`strategic-compact`; harness gợi ý từ 70% cửa sổ ngữ cảnh). Kiểm tra ngữ cảnh bằng `context-budget` khi phiên trở nên nặng.
- Chọn mô hình có chủ đích: `/model-route`. Chỉ định mô hình rõ ràng cho subagent (harness sẽ nhắc bạn). Xem `cost-aware-claude-pipeline`.
- Viết test trước và kiểm chứng trước khi phát hành (`tdd-workflow`, `verification-loop`). Dùng người rà soát độc lập (`/review-pr`, `/santa-loop`) cho đoạn mã có rủi ro.
- Đọc các thông báo chi phí và `/cost-report`. Bản bàn giao tốn vài cent mỗi lần kết thúc phiên và chỉ chạy khi nhật ký có thay đổi.
- Để cổng làm việc: nêu những sự việc nó yêu cầu, và không bao giờ bỏ qua hook của git.

## Phần B: Một phiên từ đầu đến cuối

Một phiên thực tế trong `tiny-ledger`: thêm tính năng báo cáo theo tháng. Các mốc giờ chỉ mang tính minh họa.

```mermaid
sequenceDiagram
  participant You as Bạn
  participant Claude
  participant Hooks as Hook của snagon-dev-mods
  participant Files as Tệp dự án
  You->>Claude: Khởi động Claude Code
  Hooks->>Claude: Đăng ký công cụ bộ nhớ
  Hooks->>Claude: Thêm quy tắc, digest, bản bàn giao
  You->>Claude: Thêm tính năng báo cáo theo tháng
  Claude->>Hooks: memory_search
  Hooks->>Claude: Các quyết định trước đó
  Claude->>You: Kế hoạch, xin xác nhận
  You->>Claude: Đã xác nhận
  Claude->>Hooks: Lệnh Bash đầu tiên
  Hooks->>Claude: Giữ lại một lần, hãy nêu sự việc
  Claude->>Files: Tạo tests/test_report.py
  Hooks->>Claude: Quy tắc đường dẫn Python nạp một lần
  Claude->>Files: Sửa src/tiny_ledger/report.py
  Claude->>Hooks: git commit
  Hooks->>Files: Quét các thay đổi đã staged
  Hooks->>Claude: Không có bí mật, commit đi qua
  Claude->>Hooks: Dừng
  Hooks->>Claude: Giữ lại một lần, hãy viết nhật ký
  Claude->>Files: Viết mục nhật ký
  You->>Claude: Kết thúc phiên
  Hooks->>Files: Khởi động tiến trình viết bản bàn giao
  Hooks->>Files: Chép các dòng quyết định và bài học vào bộ nhớ
```

| Thời gian | Điều xảy ra | Bạn thấy gì |
|------|--------------|-------------|
| 09:00 | Bạn khởi động Claude Code trong `tiny-ledger`. Các hook đăng ký công cụ bộ nhớ, kiểm tra sqlite3, và thêm vào ngữ cảnh các hướng dẫn, `.snagon/CLAUDE.md` của bạn, memory digest và bản bàn giao của hôm qua | Không có gì thêm, hoặc một thông báo ngắn nếu thiếu sqlite3 |
| 09:01 | Bạn gõ "Add the monthly report feature". Claude gọi `memory_search` để tìm các quyết định trước đó về báo cáo và tiền | Một lần gọi công cụ `memory_search` với các quyết định trước đó |
| 09:03 | Claude đề xuất một kế hoạch (`/plan`); bạn xác nhận | Một kế hoạch và một câu hỏi xác nhận |
| 09:05 | Lệnh Bash đầu tiên của Claude (chạy test) bị cổng giữ lại một lần; Claude nêu sự việc và thử lại | Một thông báo của cổng, rồi cùng lệnh đó chạy |
| 09:06 | Claude tạo `tests/test_report.py`. Cổng yêu cầu nêu sự việc trước lần tạo đầu tiên; sau đó quy tắc đường dẫn cho Python được nạp một lần | Một thông báo của cổng, rồi tệp được tạo |
| 09:20 | Test đạt. Claude sửa `src/tiny_ledger/report.py` (lại phải nêu sự việc cho lần sửa đầu tiên của tệp đó) | Một thông báo của cổng cho tệp mới, rồi lần sửa |
| 09:35 | Claude chạy `git commit`. Git guard quét các thay đổi đã staged, không thấy bí mật nào, và commit đi qua. Thông báo chi phí có thể hiện sau đó nếu phiên vượt 5 USD | Kết quả commit |
| 09:40 | Claude dừng. Lần dừng bị giữ lại một lần kèm lời nhắc viết nhật ký. Claude viết mục nhật ký (giờ thật, tệp đã đổi, một dòng quyết định, một dòng bài học, bước tiếp theo) rồi dừng | Một lời nhắc, rồi mục nhật ký, rồi câu trả lời cuối |
| 09:41 | Bạn kết thúc phiên. Tiến trình viết bản bàn giao khởi động ở nền và ghi `.snagon/handoff/<date>.md` khoảng 20 giây sau. Các dòng quyết định và bài học được đưa vào bộ nhớ | Không có gì; dấu nhắc trả về ngay |
| Ngày hôm sau | Phiên mới tự nhận bản bàn giao đó và memory digest | Claude đã biết bạn dừng ở đâu |
