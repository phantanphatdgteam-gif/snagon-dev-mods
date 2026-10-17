# Flow: hướng dẫn cho Chủ dự án

Flow là vòng làm việc có kiểm soát của snagon-dev-mods: lập plan, viết test trước, cài đặt, judge chạy lệnh thật, review có xác nhận, kiểm tra toàn bộ, rồi phát hành. Mod quyết định agent nào làm gì qua ticket; Chủ dự án duyệt ở các mốc bằng lệnh `/flow-*`. Bản này chạy với dự án TypeScript (có `package.json` hoặc `tsconfig.json`) trên macOS, trong một repo git đang ở một nhánh và có remote.

Phần đầu tài liệu nói cách dùng: các bước, các lệnh, plan trông thế nào, số vòng và chi phí, review, và khi flow bị chặn. Phần sau là bốn điều phải biết trước khi dùng: sandbox bắt buộc, kiểm lại sau commit định dạng lại, giới hạn cây khi git gc, và các rủi ro còn lại đã nêu.

## Một flow đi thế nào

Flow gắn với một repo git (các worktree của cùng repo dùng chung một flow), và tại một lúc chỉ một phiên giữ nó; phiên khác chỉ được xem cho tới khi Chủ dự án gõ một lệnh flow ở đó. Mỗi prompt, main nhận một thẻ flow ngắn (tối đa 12 dòng): đang ở bước nào, số vòng đã dùng, finding còn mở, lý do bị chặn nếu có, sandbox, chi phí so với trần, và bước tiếp kèm lệnh. `/flow-status` cho Chủ dự án xem đúng thẻ đó. Khung flow (pane) chỉ mở khi có gì chờ duyệt; hash8 và mã phát hành chỉ hiện ở đó.

1. Thiết lập. `/flow-setup` dò stack, các lệnh `test`, `lint`, `typecheck`, `build`, khối sandbox, remote và nhánh phát hành, rồi hiện tất cả trong khung flow. Có gì khiến flow chưa bắt đầu được ở đây thì lệnh trả về danh sách mọi lý do, thay cho khung. `/flow-approve setup <hash8>` chốt cấu hình; agent ghi khối sandbox vào `.claude/settings.local.json` và chạy lệnh thử sandbox (mục 1). Sau đó judge chạy mọi lệnh một lần trên dự án như hiện tại, làm baseline. Lệnh nào đỏ thì `/flow-status` hiện baseline và `/flow-approve baseline <hash8>` nhận nó theo kiểu "không thêm lỗi mới"; lệnh đỏ mà không đọc được lỗi thì phải sửa, hoặc bỏ bằng `/flow-setup <lệnh>=none`.
2. Plan. `/flow-plan <cần xây gì>` giao việc cho planner (Opus). Planner viết `docs/flow/plan.md`; mod kiểm plan và trả lỗi cho planner sửa. Plan đạt thì `/flow-plan` (không kèm chữ) hiện nó trong khung flow, kèm trần chi phí của flow; `/flow-approve plan <hash8>` chốt plan. Không ưng thì `/flow-reject plan` rồi nói lại cần xây gì.
3. Xây. `/flow-build` chạy lần lượt từng tính năng của plan; giữa hai tính năng không cần gõ gì.
   - RED: agent tdd-guide viết test cho các tiêu chí của tính năng. Test phải đỏ đúng cách (thiếu module mới, thiếu export, hoặc assertion sai), rồi được khóa lại: sửa hay làm yếu test RED về sau là bị bắt.
   - Viết mã: agent tdd-guide cài đặt, chỉ sửa được các file plan ghi cho tính năng đó.
   - Judge: chạy mọi lệnh đã duyệt và các test mang mã tiêu chí, so với baseline, quét hạ chuẩn và rác kỹ thuật mới. Đỏ thì giao ticket debug.
   - Review: xem mục "Review và các lần sửa".
   - Đạt thì tính năng được niêm phong, flow sang tính năng sau.
4. Kiểm tra. `/flow-verify` chạy lại mọi lệnh ở cây hiện tại cùng mọi tiêu chí Required, quét rác trên toàn bộ thay đổi của flow, rồi viết `docs/flow/verify.md` bằng ngôn ngữ của Chủ dự án.
5. Phát hành. Nếu phần đã kiểm tra chưa được commit, `/flow-ship` nhờ main commit (`.claude/settings.local.json` không vào commit), rồi Chủ dự án gõ lại `/flow-ship`. Khi đó flow quét các commit sẽ đẩy và file của HEAD tìm dữ liệu riêng tư, rồi hiện bản phát hành vừa một màn hình: commit, remote, số commit, kết quả quét, và dòng `Báo cáo kiểm tra: docs/flow/verify.md (<hash8>)`. `/flow-approve release <hash8> <mã>` kiểm lại tất cả, mod tự push, flow xong. Mã sai thì mã đó bị hủy; `/flow-ship` cho mã mới.

Theo quy tắc của flow, main không tự viết plan, test hay mã mà khởi động ticket. Với mỗi ticket, main gọi Agent với prompt `TICKET <id>`; mod thay bằng nội dung ticket, đúng agent và model. Agent chạy nền; khi có thông báo agent xong, main gọi `flow_check` để flow đi tiếp. Mã finding và mã ticket không bao giờ dùng lại trong một flow, kể cả sau khi tính năng được niêm phong.

## Các lệnh

| Lệnh | Khi nào |
|---|---|
| `/flow-setup [<lệnh>=<argv>] [<lệnh>=none] [tools=+<Tên>] [mcp=+<tên tool MCP>]` | Bắt đầu flow, hoặc đóng băng lại cấu hình (lệnh, tool, tool MCP) |
| `/flow-plan <cần xây gì>` | Giao việc cho planner |
| `/flow-plan` | Hiện plan đã qua bước kiểm để duyệt |
| `/flow-build` | Bắt đầu xây các feature của plan đã duyệt |
| `/flow-verify` | Kiểm tra toàn bộ sau feature cuối, hoặc kiểm lại khi flow bảo |
| `/flow-ship` | Xem bản phát hành và mã phát hành; nếu phần đã kiểm tra chưa commit thì nhờ main commit trước |
| `/flow-approve setup\|baseline\|plan\|waive <hash8>` | Duyệt đúng nội dung khung flow đang hiện |
| `/flow-approve release <hash8> <mã>` | Duyệt phát hành, kèm mã 6 ký tự |
| `/flow-decide <X-n> fix\|reject\|followup` · `/flow-retry plan\|F-NN\|verify\|check\|cost` · `/flow-waive check:<cmdId>\|FL-n\|J-n <lý do>` · `/flow-reject plan` | Lối ra khi flow bị chặn; thẻ flow nêu đúng lệnh cho từng lý do |
| `/flow-status` · `/flow-off [<id8>]` | Xem trạng thái; tắt flow |

Lệnh `/flow-*` chỉ được nhận khi Chủ dự án gõ ở ô nhập (hoặc qua bridge); lệnh duyệt phát hành chỉ nhận từ ô nhập. Hash8 và mã phát hành chỉ hiện trong khung flow (pane). Lệnh gõ trong lúc agent đang làm việc được Claude Code xếp hàng và chạy khi lượt đó kết thúc. Một đoạn dài dán vào ô nhập (ví dụ `/flow-plan` kèm cả trang mô tả) bị Claude Code coi là "đoạn dán" và gửi cho model như một prompt, không chạy lệnh: hãy gõ lệnh ngắn và để mô tả dài trong một file của dự án (`/flow-plan Xây ba tính năng mô tả trong docs/intent.md`), planner sẽ đọc file đó.

## Plan trông thế nào

Planner viết `docs/flow/plan.md`; Chủ dự án đọc và duyệt. Mod chỉ nhận plan đúng dạng dưới đây, và báo từng lỗi kèm số dòng để planner sửa:

```markdown
## Acceptance
- AC-001 (Required): adding two numbers returns their sum. Verification: test name contains `AC-001`
- AC-002 (Optional): a CLI prints the sum. Verification: test name contains `AC-002`

## Features
### F-01: Add numbers
- ACs: AC-001
- Files: src/sum.ts, tests/sum.test.ts (new)
- Security: no

### F-02: Print the sum
- ACs: AC-002
- Files: src/cli.ts (new), tests/cli.test.ts (new)
- Security: yes
```

- Mỗi tiêu chí là một dòng `- AC-nnn (Required|Optional): <hành vi>. Verification: …`, không trùng số. Tiêu chí nói một hành vi mới; "test cũ vẫn xanh" là điều kiện xong của mọi tính năng, không phải tiêu chí. Test của tiêu chí mang mã của nó trong tên, nên judge biết test nào chứng minh tiêu chí nào.
- Mỗi tính năng là `### F-nn: <tên>` rồi đúng ba dòng `- ACs:`, `- Files:`, `- Security: yes|no`, mỗi dòng một lần; số chạy F-01, F-02, … theo thứ tự, tối đa 50 tính năng.
- Tiêu chí Required nào cũng phải có tính năng đảm nhận. Tính năng nào cũng có ít nhất một tiêu chí và một file test.
- `Files:` là đường dẫn file thường trong dự án; file chưa có thì ghi `(new)`. Không nhận thư mục, ký tự đại diện, file trong plugin đang nạp, `.snagon/`, file được bảo vệ (cấu hình git, Claude, trình soạn thảo, file rc, `verify.md`) hay file riêng tư (khóa, `.env`).
- Không để việc bỏ ngỏ (`TBD`, `TODO`, `later`, `Deferred:`) và không có ký tự vô hình.
- `Security: yes` thêm security-reviewer vào mỗi vòng review của tính năng đó. Mod cũng tự bật nó khi mã mới đụng tới chỗ nhạy cảm như file, mạng, tiến trình, biến môi trường, mã hóa, xác thực hay cơ sở dữ liệu.

## Số vòng và chi phí

| Phạm vi | Sửa | Review | Debug | Judge chạy tối đa | `/flow-retry` (một lần) thêm |
|---|---|---|---|---|---|
| plan | 3 | — | — | 4 | 1 sửa |
| mỗi tính năng | 3 | 3 | 4 | 15 | 1 sửa, 1 review, 2 debug |
| verify | 2 | — | 3 | 9 | 1 sửa, 2 debug |

- Sửa: ở plan, mỗi ticket của planner đều tính, kể cả lần đầu. Ở tính năng, lần RED đầu và lần viết mã đầu không tính; RED hay viết mã bị giao lại, và mỗi ticket sửa, tính một lượt. Ở verify, sửa là sửa rác kỹ thuật.
- Review: vòng đầu và mỗi vòng xem lại; một vòng gồm mọi reviewer cần có. Vòng mà reviewer không trả lời đủ được hỏi lại và vẫn tính một vòng; ticket sửa phạm vi và ticket mất khi khởi động lại phiên thì không tính.
- Debug: mỗi lần judge đỏ được giao cho agent debug.

Trần chi phí: 15 USD mỗi phiên; trần của flow chốt lúc duyệt plan, bằng (2 × số tính năng + 1,2) × 1,5 làm tròn lên (11 USD cho ba tính năng, 5 USD cho một; trước khi duyệt plan là 60). Chạm trần thì flow chặn `cost`; `/flow-retry cost` nâng trần thêm một nửa, một lần. Đo thật trên dự án thử ba tính năng (lượt 17–19): 8,1–9,2 USD và 16–19 phút một flow; một tính năng 1,1–1,4 USD khi review đạt ngay, mỗi lần sửa kèm vòng xem lại thêm khoảng 1–1,5 USD.

## Review và các lần sửa

- Judge xanh thì mở một vòng review: một ticket cho reviewer mã (typescript-reviewer khi từ 70% số dòng đổi là TypeScript, không thì code-reviewer), thêm security-reviewer khi tính năng cần (mục trên).
- Finding CRITICAL hay HIGH chặn việc niêm phong. MEDIUM và LOW còn mở lúc niêm phong thành việc để sau, ghi trong báo cáo kiểm tra.
- Còn finding chặn thì agent viết mã nhận một ticket sửa. Câu trả lời ghi `FIX <id> | <file>:<dòng đầu>-<dòng cuối>` (sửa ở đâu) hoặc `DISPUTE <id> | <lý do>` (phản đối) cho các finding. Nó phải trả lời ít nhất một finding CRITICAL hay HIGH đang mở của tính năng, không thì không được chứng thực và ticket được giao lại; finding nào bị bỏ qua thì vẫn mở cho vòng sau. Dòng FIX được đọc như agent viết: đường dẫn tuyệt đối, lý do sau range hay `file:n` đều nhận.
- Sau ticket sửa, judge chạy lại, và mọi hunk thay đổi phải nằm trong FIX range mà agent báo (hoặc trong file test của tính năng). Nếu không, flow giao một ticket sửa phạm vi (một lần mỗi vòng review, không tính vòng): agent hoàn lại hunk đó (`REVERT FL-n`) hoặc báo một FIX range phủ trọn nó. Lần sau vẫn lệch thì flow chặn và hỏi Chủ dự án miễn trừ (`/flow-waive FL-n <lý do>`).
- Vòng xem lại (delta) chỉ cho reviewer xem phần đổi từ vòng trước. Reviewer ghi `RESOLVED`, `OPEN`, `UPHOLD` hoặc `WITHDRAW` cho từng finding, có thể kèm lý do. Reviewer không phán quyết một finding đã sửa hay bị phản đối thì vòng đó được hỏi lại; ticket sửa không bao giờ được phát khi không còn finding nào để sửa.
- Reviewer giữ nguyên (`UPHOLD`) finding mà tác giả phản đối thì flow chặn `dispute`, và Chủ dự án quyết bằng `/flow-decide <id> fix|reject|followup`.
- Tính năng đạt khi judge xanh ở cây hiện tại, vòng review cuối có đủ reviewer ở đúng cây đó, và không còn finding CRITICAL hay HIGH nào mở.

## Khi flow bị chặn

Bị chặn là CHƯA xong. Thẻ flow ghi `Đang bị chặn, CHƯA xong: <lý do>`, và dòng `Bước tiếp: <Chủ dự án> chọn. Lệnh: …` nêu đúng lối ra. Main dừng và báo lại; Chủ dự án chọn một lối ra.

| Lý do | Lối ra |
|---|---|
| Hết vòng (`cap`); reviewer giữ nguyên finding (`dispute`) | `/flow-decide <X-n> fix\|reject\|followup` · `/flow-retry <phạm vi>` · `/flow-reject plan` |
| Plan đã duyệt bị đổi (`frozenChanged`); tính năng quá lớn cho một ticket (`split`); plan còn lỗi kiểm (`planLint`) | `/flow-reject plan` |
| File quyết định cách chạy lệnh đổi (`cmdSrc`); remote hay cấu hình git của lần push đổi (`remoteChanged`); lệnh chạy quá lâu (`tooSlow`); sandbox khác bản đã duyệt (`sandboxMismatch`); lệnh thử sandbox chưa kết luận (`probeInconclusive`); có khóa cho lệnh thoát sandbox (`sandboxKey`) | `/flow-setup` |
| File được bảo vệ đổi (`tampered`) | `/flow-setup` · `/flow-off` |
| Một phép kiểm không chạy được (`couldNotRun`) | `/flow-retry check` |
| Main không khởi động ticket sau 3 lần nhắc (`stalled`) | `/flow-retry check` · `/flow-off` |
| Chạm trần chi phí (`cost`) | `/flow-retry cost` · `/flow-off` |
| Lệnh đỏ (`redCheck`) | `/flow-waive check:<cmdId> <lý do>` |
| Hạ chuẩn (`floor`), rác kỹ thuật (`junk`), chữ nhắm vào reviewer (`injection`), test RED bị sửa (`redTestChanged`) | `/flow-waive <id> <lý do>` |
| Remote từ chối push (`pushRejected`); báo cáo kiểm tra bị sửa sau verify (`reportChanged`) | `/flow-verify` · `/flow-off` |
| Đẩy lên sẽ lộ dữ liệu riêng (`publish`) | `/flow-verify` · `/flow-ship` · `/flow-off` |
| Phiên khác đang giữ flow (`viewOnly`) | `/flow-status`; lệnh flow nào gõ ở phiên này cũng lấy lại flow |
| Đang chờ Chủ dự án (`awaitingOwner`); không mở được khung hiển thị (`noSurface`) | Lệnh flow đang chờ |

- `/flow-retry` cho mỗi phạm vi một lần thêm vòng; `/flow-retry check` chạy lại phép kiểm, không tính vòng. Một miễn trừ cũng hiện trong khung flow trước, và chỉ có hiệu lực sau `/flow-approve waive <hash8>`.
- Nếu main không khởi động ticket được giao, hook Stop nhắc lại tối đa 3 lần; sau đó flow chặn với lý do `main không khởi động ticket T-n sau 3 lần nhắc` (không tính vòng). Mỗi lần Chủ dự án tự gõ vào, bộ đếm bắt đầu lại. Chủ dự án đọc lý do main nêu, rồi gõ `/flow-retry check` để giao lại ticket hoặc `/flow-off`.
- Một lệnh gọi bị từ chối bằng câu bắt đầu `flow:` là guard đang làm đúng việc. Main làm theo gợi ý trong câu đó, hoặc dừng lại hỏi Chủ dự án; không lách bằng cách khác.

## 1. Sandbox bắt buộc

Flow chỉ chạy khi sandbox Bash có sẵn của Claude Code đang bật cho dự án; không có chế độ yếu hơn.

- `/flow-setup` đề xuất khối `sandbox` cho `.claude/settings.local.json`: bật sandbox, không cho lệnh chạy ngoài sandbox, chỉ mở mạng tới registry của các lockfile tìm thấy, chỉ cho ghi thêm vào thư mục cache của trình quản lý gói, và che các file đăng nhập (`~/.npmrc`, `~/.ssh`, `~/.config/gh`, …), transcript của Claude Code và dữ liệu flow (`~/.snagon/flow`).
- Khung echo hiện nguyên văn file sau khi ghép (kèm sha8 trước/sau) và cấu hình sandbox thực tế với lớp cài đặt của từng khóa. Chủ dự án duyệt bằng `/flow-approve setup <hash8>`; agent ghi đúng từng byte đó một lần. Nếu nội dung có chuỗi giống bí mật, flow không nhờ agent ghi (nội dung sẽ vào transcript) mà nhờ Chủ dự án tự dán, rồi chạy `/flow-status`.
- Sau khi ghi, agent chạy một lệnh thử: `/usr/bin/curl -q --noproxy '*' -s -S -m 5 -o /dev/null -w %{http_code} https://example.com` (lệnh thử trong tài liệu sandbox của Claude Code: không đi qua proxy nên trong sandbox không phân giải được tên miền, `curl: (6) Could not resolve host`, và không hiện hộp thoại nào; đường dẫn tuyệt đối và `-q` để không shim `curl` hay `.curlrc` nào đổi được kết quả). Sandbox chỉ được tính là đang bật khi lệnh này thất bại như vậy (hoặc bị proxy từ chối thẳng, exit 56, khi máy bật `strictAllowlist`) VÀ chính mod chạy cùng lệnh đó ngoài sandbox thấy mạng vẫn thông (đối chứng, cùng đường trực tiếp không qua proxy: máy mất mạng, DNS hỏng hay mạng chỉ ra được qua proxy thì lệnh thử không nói lên gì và flow chặn `probeInconclusive`; kiểm tra mạng rồi `/flow-setup`). Trước khi lệnh thử đạt trong phiên, không agent nào được khởi động và Bash chỉ được chạy đúng lệnh thử này từ agent chính (một Bash mà sandbox không bọc không thể cài file khởi động shell để giả kết quả). Mỗi phiên sau cũng chạy lại lệnh thử này trước ticket đầu tiên. Lưu ý: ở chế độ quyền `acceptEdits`/thủ công, một lệnh Bash gọi tới host ngoài `allowedDomains` qua proxy làm Claude Code hỏi Chủ dự án ("Network request outside of sandbox … Do you want to allow this connection?"); trong flow hãy từ chối (Esc), trừ khi chính Chủ dự án muốn mở host đó.
- `/flow-setup` từ chối (nêu khóa và lớp cài đặt chứa nó, để Chủ dự án xóa ở đó) khi cài đặt ở bất kỳ lớp nào có khóa cho lệnh thoát hay nới sandbox (ví dụ `excludedCommands`, `allowUnixSockets`, `allowLocalBinding`, `enableWeakerNestedSandbox`, `filesystem.disabled`, `allowedDomains: ["*"]`), cho ghi vào `~/.claude`, `~/.snagon` hay thư mục plugin, hoặc có khóa sandbox flow chưa biết. Nó cũng từ chối khi môi trường có biến đăng nhập registry (`NPM_TOKEN`, …), khi `.npmrc`/`.yarnrc.yml` của dự án chứa thông tin đăng nhập, khi plugin đang nạp nằm ở chỗ ghi được (trong dự án, thư mục tạm, thư mục sandbox cho ghi) hoặc dự án nằm trong một thư mục plugin (kể cả thư mục mod của engine `~/.claude/dev-mods`, nơi việc nạp plugin-authoring bật hot reload), khi HEAD tách rời, hoặc khi chưa có remote.
- Trong lúc flow chạy, mỗi lần `flow_check` so cấu hình sandbox (bản ghép và từng lớp) với bản đã duyệt; khác là chặn (`cấu hình sandbox khác khối đã duyệt`), lối ra là `/flow-setup`.
- Chế độ quyền `bypassPermissions` cho lệnh ra khỏi sandbox mà không hỏi, nên khi flow bật ở chế độ đó chỉ được đọc; hãy đổi chế độ (shift+tab).
- Judge chạy lệnh test/lint/build trong `sandbox-exec` của macOS với môi trường rỗng và không có mạng. Trên máy không phải macOS, judge không chạy: flow bị chặn ở lần judge đầu (`một phép kiểm không chạy được`). Plan §2.6 ghi "Linux chạy không sandbox cho tới R2"; bản hiện tại chọn chặn hẳn.
- Khi flow xong, file `.claude/settings.local.json` vẫn giữ khối sandbox; Chủ dự án có thể xóa nếu muốn.

## 2. Kiểm lại sau commit định dạng lại

Ở bước phát hành, khung duyệt chỉ tóm tắt (commit, remote, kết quả quét, hash của báo cáo kiểm tra) để vừa một màn hình; báo cáo đầy đủ nằm ở `docs/flow/verify.md`. `/flow-ship` đòi phần đã kiểm tra phải được commit. Nếu chưa, agent chạy `git add -A` rồi `git commit`; hook commit của dự án chạy như bình thường. Nếu một hook pre-commit định dạng lại file (prettier, `eslint --fix` qua husky hay lint-staged), nội dung commit không còn đúng cây đã kiểm tra, và lần `/flow-ship` kế tiếp báo:

> Mã nguồn đã đổi sau khi kiểm tra. Chạy lại /flow-verify trước khi phát hành.

`/flow-verify` khi đó chạy lại toàn bộ bước kiểm tra (mọi lệnh đã duyệt, mã AC bắt buộc, quét rác, báo cáo `docs/flow/verify.md`) trên cây mới, không tính vòng nào. Chỉ khi lần chạy lại đỏ thì vòng debug/sửa của bước verify mới được dùng. Xong thì `/flow-ship` lại. Nếu bản phát hành đã hiện trong khung flow, bản đó bị bỏ; `/flow-ship` sau đó hiện bản mới với mã mới.

Muốn tránh lượt kiểm lại này, hãy đưa trình định dạng vào lệnh lint đã duyệt (ví dụ `prettier --check`): code chưa định dạng thì judge đỏ ngay trong lúc xây, ticket sửa nó, và tới lúc commit hook không còn gì để đổi.

## 3. Giới hạn cây khi git gc

Flow giữ mã của nhiều cây git: ảnh chụp thư mục làm việc ghi bằng một index tạm, không phải commit (cây lúc feature bắt đầu, cây lúc RED, cây của từng vòng review, cây judge đã chạy, cây đã kiểm tra, cây phát hành). Không ref nào giữ các cây này, nên `git gc` coi chúng là rác: khi gc chạy (git tự chạy `gc --auto` sau một số lệnh khi đối tượng rời nhiều lên, hoặc khi gọi `git gc`/`git maintenance`), nó xóa những cây đã cũ hơn `gc.pruneExpire` (mặc định 2 tuần). Đã thử với git thật (`git gc --prune=now`): sau đó `git diff <cây>` báo `fatal: bad object`.

Chỉ cây của feature đang làm dở được đọc lại như đối tượng git (cây bắt đầu, cây RED, cây của vòng review trước); feature đã seal không cần cây nữa, và verify so từ commit gốc (`baseSha`, gc không xóa). Vậy rủi ro là một feature nằm dở hơn khoảng 2 tuần trong khi gc chạy.

Hiện trạng: plan §5.4 định "cây bị gc xóa thì kiểm lại, không tính vòng", nhưng bản hiện tại CHƯA làm. Khi cây của feature đang làm bị xóa, `flow_check` báo lỗi git `bad object` mỗi lần gọi; nếu feature đó có sửa file nguồn lệnh (`package.json`, cấu hình test), flow bị chặn nhầm là `cmdSrc`. Lối ra duy nhất hiện nay là `/flow-off` rồi bắt đầu flow mới.

Cách tránh, nếu flow có thể kéo dài: trước `/flow-setup`, đặt thời hạn dài hơn flow, ví dụ `git config gc.pruneExpire 3.months.ago` (git chỉ xóa đối tượng rác cũ hơn 3 tháng), và sau khi flow xong chạy `git config --unset gc.pruneExpire` để git dọn như cũ. Đổi cấu hình git của repo khi flow đang chạy làm đổi hash cấu hình (`H_cfg`), nên flow chặn `tampered (config)` cho tới khi `/flow-setup` đóng băng lại.

Nếu đã viết lại lịch sử để bỏ một bí mật (flow chặn `publish`), bản cũ vẫn nằm trong `.git` một thời gian: reflog giữ nó tới khi mục reflog hết hạn (`gc.reflogExpireUnreachable`, mặc định 30 ngày), rồi thêm thời hạn `gc.pruneExpire`. Muốn xóa hẳn sau khi flow xong:

1. Xóa mọi ref còn trỏ tới bản cũ: các ref sao lưu `git filter-branch` để lại (`git for-each-ref --format='delete %(refname)' refs/original/ | git update-ref --stdin`; không có ref nào thì lệnh không làm gì), và stash, tag hay nhánh tạo trước khi viết lại mà còn chứa bí mật.
2. Chạy `git reflog expire --expire=now --all && git gc --prune=now` (lệnh này cũng xóa mọi điểm khôi phục trong reflog).

Đã thử với git thật: sau `git filter-branch`, bí mật còn sống qua bước 2 cho tới khi xóa ref sao lưu ở bước 1.

## 4. Rủi ro còn lại đã nêu

Mod chặn những gì agent làm được qua tool, sandbox Bash và profile của judge. Những rủi ro dưới đây nằm ngoài tầm đó; chúng đã được ghi trong plan và được chấp nhận cho bản MVP.

### Plan §2.6

- Một tiến trình khác của cùng người dùng, chạy ngoài phiên, ghi được file bản ghi flow, thư mục plugin và file cài đặt. Tool của phiên, sandbox Bash và profile judge đều không ghi được. Lưới đỡ: hash toàn vẹn plugin, `H_cfg`, so cấu hình sandbox, các lần duyệt theo echo, và diff của bản phát hành.
- Plugin khác đang nạp có thể viết lại các lời gọi state của mod này. Chúng là mã được tin; `/flow-setup` chỉ bảo đảm agent không ghi được mã nguồn của chúng.
- Nếu chính dự án đang chạy flow được nạp làm plugin (ví dụ `claude --plugin-dir <dự án>`, hay bật hot reload cho nó), mã agent viết sẽ chạy với quyền của phiên. Mod từ chối dự án nằm trong mọi thư mục plugin nó biết, kể cả `~/.claude/dev-mods`; đừng tự nạp dự án đang chạy flow.
- `/flow-decide`, `/flow-retry`, `/flow-off` không gắn với nội dung echo, nên một phím gõ bị chèn vào ô nhập có thể dùng chúng. Một lệnh `/flow-approve` giả chỉ duyệt được đúng cái khung flow đã hiện; phát hành còn cần mã. Phép thử 2 (spike 2) còn phải cho thấy không có đường chèn nào từ sandbox Bash hay từ profile judge.
- Agent đọc được màn hình rồi in một liên kết lệnh để bấm (F39): mã phát hành và hash8 nằm trên màn hình khi khung flow mở. Guard chặn `screencapture`, `osascript` và MCP đọc màn hình; phần còn lại trông vào spike 2/11 và việc hash8 phải tự gõ.
- Dịch vụ loopback Chủ dự án đang chạy (cổng debug của Chrome, dev server): plan §2.6 ghi judge với tới được. Bản hiện tại đóng mạng của judge (F4), trừ các cổng localhost liệt kê trong `loopbackPorts` của stack (mặc định không có), nên rủi ro này chỉ còn với cổng được thêm vào đó.
- Thông tin đăng nhập: biến đăng nhập registry làm setup từ chối; các biến bí mật khác chỉ hiện tên trong echo và bị `env -i` của judge bỏ đi. Lệnh push lúc phát hành dùng cấu hình đăng nhập git toàn cục của người dùng, sau khi so với các khóa đã đóng băng.
- Mã phát hành có bị ghi vào transcript qua nội dung khung hay log không: còn chờ spike 11.
- Ngoài mã của test runner (đã khóa hash ở setup), sửa sâu bên trong các package khác ở `node_modules` không bị phát hiện cho tới khi có kiểm toàn vẹn runner ở R2.

### Guard của bước 8 (plan §14 F43)

- Phép mở rộng của shell lách được danh sách từ `screencapture` và lệnh publish (`c=screencaptur; ${c}e`); sandbox không chặn chụp màn hình, nên F39 trông vào spike 2/11 và hash8 tự gõ.
- Một tool MCP được cho phép, nhận đường dẫn đi qua liên kết.
- Grep/Glob đi theo liên kết bên dưới chỗ bắt đầu, nếu tool đó đi theo liên kết.
- Transcript bị tạo liên kết cứng: trông vào việc sandbox từ chối `link()` từ nguồn bị che (spike 2).
- Liên kết bị tráo vào rồi tráo lại trong một lần đọc/ghi: phép kiểm lại sau lệnh bắt được, trừ khi được trả về trong vài mili giây.

### Không chạy nền (plan §14 F47, quyết định F47-A của Anh Phát, 2026-10-17)

Một tiến trình chạy nền có thể tráo file nguồn lệnh, runner hay cấu hình giữa lúc judge kiểm và lúc judge chạy, biến lượt đỏ thành xanh. Vì vậy khi flow bật, guard từ chối Bash có `run_in_background`, dấu `&` đẩy lệnh ra nền, các chương trình `setsid`, `coproc`, `tmux`, `screen`, `daemonize` ở bất kỳ vị trí nào, và mọi `&` (trừ `&&`, `;&`, `|&`, `>&`, `<&`, `&>` viết thẳng) khi lệnh có shell hay builtin chạy chữ (`eval`, `sh`, `bash`, `trap`, `source`, …). Monitor cũng bị từ chối (F42-A) cho tới khi có phép thử cho thấy sandbox bọc lệnh của nó.

- Báo nhầm đã chấp nhận: các từ trên khi chỉ là chữ (`grep screen`, commit message có chữ "screen"; câu từ chối chỉ cách dùng tool Grep hoặc đổi từ), dấu `&` trong biểu thức số học hay trong chữ mà shell đọc lại, dấu `#` sau dấu `)` của subshell.
- Rủi ro còn lại: chương trình tự sinh tiến trình sống lâu hơn lệnh (script hay trình thông dịch tự fork hoặc daemonize, `system(…&)` của awk/perl/python, process substitution `>(…)`, launchd, cron, `open`), shell mà guard không đọc được tên (`$SHELL -c …`), và chữ do shell dựng lúc chạy (biến, chuỗi thoát như `\x26`, file). Muốn đóng hẳn cần phương án B (judge chạy trên một bản chụp); Anh Phát quyết định xem lại phương án B sau đợt chạy thử ở bước 13.
