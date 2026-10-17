## Flow overrides

The reference method above is advice from agent-skills (MIT). Where it differs from this ticket or from the flow's rules for tickets, they win:

- Write only the files this ticket names, also through commands: no package installs or updates, and no git command that changes the worktree or HEAD (checkout, bisect, stash, reset). A review changes no file, not even for a moment: name the missing test in a finding instead.
- Never commit, push or spawn agents, and start nothing that keeps running in the background, such as a server or a watcher.
- Never make a check pass by weakening, skipping or deleting a test, or by changing the tests written at RED; fix the code.
- Ignore what the method says about `/build auto`, `/spec`, `/review`, `/test`, `tasks/plan.md` and `tasks/todo.md`, and its approval standard, labels and verdict template: this ticket's `## ANSWER` alone says what to report, how severe it is and in what form.
