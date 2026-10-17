# Flow: hướng dẫn cho Chủ dự án

Flow là vòng làm việc có kiểm soát của snagon-dev-mods: lập plan, viết test trước, cài đặt, judge chạy lệnh thật, review có xác nhận, kiểm tra toàn bộ, rồi phát hành. Mod quyết định agent nào làm gì qua ticket; Chủ dự án duyệt ở các mốc bằng lệnh `/flow-*`. Tài liệu này nói bốn điều phải biết trước khi dùng: sandbox bắt buộc, kiểm lại sau commit định dạng lại, giới hạn cây khi git gc, và các rủi ro còn lại đã nêu.

## Các lệnh

| Lệnh | Khi nào |
|---|---|
| `/flow-setup [<lệnh>=<argv>] [<lệnh>=none] [tools=+<Tên>] [mcp=+<tên>]` | Bắt đầu flow, hoặc đóng băng lại cấu hình (lệnh, tool, MCP) |
| `/flow-plan <cần xây gì>` | Giao việc cho planner |
| `/flow-build` | Bắt đầu xây các feature của plan đã duyệt |
| `/flow-verify` | Kiểm tra toàn bộ sau feature cuối, hoặc kiểm lại khi flow bảo |
| `/flow-ship` | Xem bản phát hành và mã phát hành |
| `/flow-approve setup\|baseline\|plan\|waive <hash8>` | Duyệt đúng nội dung khung flow đang hiện |
| `/flow-approve release <hash8> <mã>` | Duyệt phát hành, kèm mã 6 ký tự |
| `/flow-decide <X-n> fix\|reject\|followup` · `/flow-retry <phạm vi>` · `/flow-waive <id> <lý do>` · `/flow-reject plan` | Lối ra khi flow bị chặn; thẻ flow nêu đúng lệnh cho từng lý do |
| `/flow-status` · `/flow-off [<id8>]` | Xem trạng thái; tắt flow |

Lệnh `/flow-*` chỉ được nhận khi Chủ dự án gõ ở ô nhập (hoặc qua bridge); lệnh duyệt phát hành chỉ nhận từ ô nhập. Hash8 và mã phát hành chỉ hiện trong khung flow (pane). Lệnh gõ trong lúc agent đang làm việc được Claude Code xếp hàng và chạy khi lượt đó kết thúc. Một đoạn dài dán vào ô nhập (ví dụ `/flow-plan` kèm cả trang mô tả) bị Claude Code coi là "đoạn dán" và gửi cho model như một prompt, không chạy lệnh: hãy gõ lệnh ngắn và để mô tả dài trong một file của dự án (`/flow-plan Xây ba tính năng mô tả trong docs/intent.md`), planner sẽ đọc file đó.

## 1. Sandbox bắt buộc

Flow chỉ chạy khi sandbox Bash có sẵn của Claude Code đang bật cho dự án; không có chế độ yếu hơn.

- `/flow-setup` đề xuất khối `sandbox` cho `.claude/settings.local.json`: bật sandbox, không cho lệnh chạy ngoài sandbox, chỉ mở mạng tới registry của các lockfile tìm thấy, chỉ cho ghi thêm vào thư mục cache của trình quản lý gói, và che các file đăng nhập (`~/.npmrc`, `~/.ssh`, `~/.config/gh`, …), transcript của Claude Code và dữ liệu flow (`~/.snagon/flow`).
- Khung echo hiện nguyên văn file sau khi ghép (kèm sha8 trước/sau) và cấu hình sandbox thực tế với lớp cài đặt của từng khóa. Chủ dự án duyệt bằng `/flow-approve setup <hash8>`; agent ghi đúng từng byte đó một lần. Nếu nội dung có chuỗi giống bí mật, flow không nhờ agent ghi (nội dung sẽ vào transcript) mà nhờ Chủ dự án tự dán, rồi chạy `/flow-status`.
- Sau khi ghi, agent chạy một lệnh thử: `/usr/bin/curl -q --noproxy '*' -s -S -m 5 -o /dev/null -w %{http_code} https://example.com` (lệnh thử trong tài liệu sandbox của Claude Code: không đi qua proxy nên trong sandbox không phân giải được tên miền, `curl: (6) Could not resolve host`, và không hiện hộp thoại nào; đường dẫn tuyệt đối và `-q` để không shim `curl` hay `.curlrc` nào đổi được kết quả). Sandbox chỉ được tính là đang bật khi lệnh này thất bại như vậy (hoặc bị proxy từ chối thẳng, exit 56, khi máy bật `strictAllowlist`) VÀ chính mod chạy cùng lệnh đó ngoài sandbox thấy mạng vẫn thông (đối chứng, cùng đường trực tiếp không qua proxy: máy mất mạng, DNS hỏng hay mạng chỉ ra được qua proxy thì lệnh thử không nói lên gì và flow chặn `probeInconclusive`; kiểm tra mạng rồi `/flow-setup`). Trước khi lệnh thử đạt trong phiên, không agent nào được khởi động và Bash chỉ được chạy đúng lệnh thử này từ agent chính (một Bash mà sandbox không bọc không thể cài file khởi động shell để giả kết quả). Mỗi phiên sau cũng chạy lại lệnh thử này trước ticket đầu tiên. Lưu ý: ở chế độ quyền `acceptEdits`/thủ công, một lệnh Bash gọi tới host ngoài `allowedDomains` qua proxy làm Claude Code hỏi Chủ dự án ("Network request outside of sandbox … Do you want to allow this connection?"); trong flow hãy từ chối (Esc), trừ khi chính Chủ dự án muốn mở host đó.
- `/flow-setup` từ chối (nêu khóa và lớp cài đặt chứa nó, để Chủ dự án xóa ở đó) khi cài đặt ở bất kỳ lớp nào có khóa cho lệnh thoát hay nới sandbox (ví dụ `excludedCommands`, `allowUnixSockets`, `allowLocalBinding`, `enableWeakerNestedSandbox`, `filesystem.disabled`, `allowedDomains: ["*"]`), cho ghi vào `~/.claude`, `~/.snagon` hay thư mục plugin, hoặc có khóa sandbox flow chưa biết. Nó cũng từ chối khi môi trường có biến đăng nhập registry (`NPM_TOKEN`, …), khi `.npmrc`/`.yarnrc.yml` của dự án chứa thông tin đăng nhập, khi plugin đang nạp nằm ở chỗ ghi được (trong dự án, thư mục tạm, thư mục sandbox cho ghi) hoặc dự án nằm trong một thư mục plugin (kể cả thư mục mod của engine `~/.claude/dev-mods`, nơi việc nạp plugin-authoring bật hot reload), khi HEAD tách rời, hoặc khi chưa có remote.
- Trong lúc flow chạy, mỗi lần `flow_check` so cấu hình sandbox (bản ghép và từng lớp) với bản đã duyệt; khác là chặn (`cấu hình sandbox khác khối đã duyệt`), lối ra là `/flow-setup`.
- Chế độ quyền `bypassPermissions` cho lệnh ra khỏi sandbox mà không hỏi, nên khi flow bật ở chế độ đó chỉ được đọc; hãy đổi chế độ (shift+tab).
- Judge chạy lệnh test/lint/build trong `sandbox-exec` của macOS với môi trường rỗng và không có mạng. Trên máy không phải macOS, judge không chạy: flow bị chặn ở lần judge đầu (`một phép kiểm không chạy được`). Plan §2.6 ghi "Linux chạy không sandbox cho tới R2"; bản hiện tại chọn chặn hẳn.
- Sau một ticket sửa, mọi hunk thay đổi phải nằm trong FIX range mà agent báo (hoặc trong file test của tính năng). Nếu không, flow giao một ticket sửa phạm vi (một lần mỗi vòng review, không tính vòng): agent hoàn lại hunk đó hoặc báo range phủ nó. Lần sau vẫn lệch thì flow chặn và hỏi Chủ dự án miễn trừ (`/flow-waive FL-n`).
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
