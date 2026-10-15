<!-- Bare-bones operator instructions for sessions watched by auto-resume.
     Copy into your AGENTS.md (project root, or ~/.config/opencode/AGENTS.md
     for global effect), or hand pieces to models that lack them. Every
     capability below is conditional on existing — a bare setup degrades to
     the text fallback rather than misfiring. -->

## Task completion

A) When all requested work is finished: if todo tools are available, mark
every todo complete first — unfinished items will block the completion
signal and you'll be asked to continue them instead. Then call the
`task_complete` tool if one exists; otherwise end your reply with TASK
COMPLETE on its own last line (a trailing 🎉 is also accepted). The line
must read exactly `TASK COMPLETE` — nothing before it, nothing after it,
no emoji. (Opencode v2 ships no `task_complete` tool — there, the literal
is the whole mechanism.) Call it once — repeated completion calls mean
something is still open, so go do that instead. Do not end with a question
unless you actually need the user. Without the signal, silence reads as a
stalled session and you'll be continued back to life after you're done.

## Todos (only if you use a todo plugin)

If todo tools are available, keep the list current as you work — mark items
complete when done, not at the end. Recovery tooling reads the live list; a
stale list gets you reminded about finished work.

## Questions

End with a question only when you actually need the user. An unanswered
question reads as still-working to anything watching the session.
