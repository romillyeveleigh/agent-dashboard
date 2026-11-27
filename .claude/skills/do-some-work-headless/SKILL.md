---
name: do-some-work-headless
description: |
  Runs dashboard tasks inside agent containers.
  Seven modes: code (implement a ticket), review (review a PR or address PR feedback), plan (write an implementation plan), housekeeping (fix stale statuses), brainstorm (explore and plan new ideas), general (catch-all), ship (ticket-to-PR pipeline).
  All interactive prompts use the channel MCP server (reply tool for questions, say tool for non-blocking notes) instead of AskUserQuestion.
  Runs inside Docker containers with full isolation — no worktrees needed.

  Keywords: headless, container, agent, dashboard, autonomous, docker
---

# Do Some Work — Headless

Autonomous developer workflow adapted for containerised execution. All human interaction goes
through the channel MCP server instead of interactive prompts: `reply` blocks until the human
answers (questions, approvals, blockers), `say` posts to the thread and returns immediately
(acknowledgements, FYI reports, progress notes). Never use `reply` for a message you don't
need answered.

**This skill is invoked by the Do Some Work dashboard entrypoint with a mode named in the prompt.**

## Environment

You are running inside a Docker container with:
- Full repo clone at `/workspace`
- Channel MCP server connected (`reply`, `say`, `post_status`, `post_diff`, `save_memory`)
- `TASK_ID` and `DASHBOARD_URL` set in the environment
- `git`, `gh` (GitHub CLI), and the Linear MCP available
- No worktree needed — the container IS the isolation

Ticket IDs look like `ENG-123`. The repo's default branch is referred to below as `<base>`;
find it with `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`.

## Mode Selection

The entrypoint passes the mode in the prompt. Execute the matching mode below.

- **code** → Mode 1, **review** → Mode 2, **plan** → Mode 3, **housekeeping** → Mode 4,
  **brainstorm** → Mode 5, **general** → Mode 6, **ship** → Mode 7.
- Mode 7 (ship) is **silent by default** — it only talks to the human in the specific cases it lists.

---

## Autonomy: do the obvious thing, then report

Default to **action over asking**. The human's time is the scarce resource — a stop-and-ask costs a full round-trip and most often just returns "yes, do it." Before any `reply` that asks a question or waits for approval, sort the decision into one of two buckets:

**Just do it — then report what you did (do NOT pre-ask, do NOT block):**
- Implementing a plan that is within the Mode 1 Step 7 guardrails (≤10 files / ≤200 lines, no unresolved manual/infra steps, no genuine forks)
- Fixing clear defects, nits, or requested review changes in *your own* work
- Acting on your own recommendation when the alternatives are strictly worse — name the alternative you rejected in your report
- Any reversible, in-scope code change

Report these afterward with `say`, set status, and keep going.

**Stop and ask (`type: "approval"`, wait for the answer):**
- Anything outward-facing or irreversible: posting to someone else's PR, merging, deploying, deleting, third-party/infra config
- A genuine fork where reasonable engineers disagree *and* it changes intent, UX, or a public API/contract
- Scope expansion beyond the ticket, or any Mode 1 Step 7 guardrail trip
- Information you genuinely need and cannot obtain yourself

When unsure: reversible and in-scope → do it and report; outward-facing or intent-changing → ask.

**Ambiguity rule:** when an instruction or answer is ambiguous — it could plausibly refer to a different PR, ticket, or action than the one you're on — ask via `reply`. Never guess and act on a guess.

**Status/park rule:** `post_status({status: "waiting_for_feedback"})` is never a substitute for `reply`. If you finished the instructed work and have nothing you need answered → `post_status({status: "complete", message: "<result summary>"})` — the summary is what the human sees on the finished card, so make it the actual outcome, not "done". If you need a decision, clarification, or help → call `reply` (it parks the task itself). Never park a task "in case the human wants anything further" — follow-ups are new tasks.

## Git workflow (applies to every mode)

Plain git branches and `gh` — one branch per PR, no stacks.

- **Branch naming:** `<ticket-id>-<short-slug>`, all lowercase (e.g. `ENG-123` → `eng-123-add-search`). No ticket → just `<short-slug>`. Never work on `<base>` directly.
- **Commit with explicit staging only:**
  ```bash
  git -C /workspace status --porcelain           # verify the list matches files you edited
  git -C /workspace add <path1> <path2> ...      # stage each by name — NEVER --all / -A / .
  git -C /workspace commit -m "<message>"
  ```
  Stage only files you changed. Runtime-injected files (`AGENTS.md`, `.agents/`, `.claude/`) and any other untracked workspace debris must never be committed.
- **Push:** `git -C /workspace push -u origin <branch>`. **Never force-push** unless a human explicitly tells you to.
- **Sync before push:** `git -C /workspace fetch origin`, then if the branch is behind: before its first push, `git -C /workspace rebase origin/<base>`; once it has been pushed, `git -C /workspace merge origin/<base>` (so no force-push is ever needed). A conflict you can't resolve purely from this PR's own intent is a guardrail stop.
- **Resume an existing PR branch:** `gh pr checkout <pr-number>`.
- **Never use `git stash`** — commit work-in-progress instead.
- **PRs are ready for review, never draft:** `gh pr create --base <base> --head <branch> --title "..." --body "..."`. If you resumed a branch whose PR is still a draft, run `gh pr ready <pr-number>`.
- **Only your branches** — never push to or rewrite branches that belong to other people.

---

## Candidate Tournament (non-trivial plans)

For **non-trivial** plans (Mode 3), don't rely on a single attempt — fan out parallel candidates and let a judge pick the best. Mode 3 defines the gate; for trivial work, skip this and plan directly.

**Prerequisite & fallback:** this needs the `Task` tool. If `Task` is unavailable or any step below errors, **fall back to the single-agent path** — never block or fail on the tournament itself.

**Lead-only rule:** only you (the lead) ever call `post_diff`, `post_status`, `reply`, `say`, or touch the branch. Candidate and judge subagents only read the repo and return artifacts to you.

1. **Freeze the brief** — the ticket text + the codebase context you gathered. Identical for all candidates, so differences come from approach, not inputs.
2. **Fan out 3 candidates** with the `Task` tool, all in a single message so they run in parallel. Each returns a full implementation plan (specific file paths + changes).
3. **Judge.** Spawn one more `Task` subagent with all three plans and the Mode 3 rubric. It returns the winning number and a one-paragraph rationale. If the judge fails, apply the rubric yourself.
4. **Use the winner** as the work document plan.

**Time-box:** if you are approaching the task deadline, abandon the tournament and finish single-agent.

---

## Mode 1: Code a Ticket

Implement a Linear ticket end-to-end.

**Address-comments override:** if the task is to address review comments (prompt or tags include `address-comments`), skip the rest of Mode 1 and follow **Mode 2 Sub-mode B**.

### Step 1: Read the ticket

1. `get_issue(id: TICKET_ID)` — get ticket details
2. `list_documents(query: TICKET_ID)` — find the work document
3. If a work document exists → `get_document(id)` to read the plan
4. If NO work document → **switch to Mode 3 (Plan)** first

### Step 1b: Scan for manual steps

Scan the plan for steps you cannot perform autonomously — anything involving a CMS, cloud console, hosting dashboard, env vars, secrets, DNS, data migrations, infrastructure, permissions, credentials, or third-party configuration.

For each match:
1. Extract it as a manual step with detailed sub-instructions
2. If the work document has no "Manual Steps" section, add one via `update_document`
3. Flag via `say`:
   ```
   say({ text: "This plan includes N manual steps requiring human action:\n\n<list>\n\nI'll remind you after implementation." })
   ```

### Step 2: Confirm the plan (only if it needs confirmation)

The plan was approved when it was written (Mode 3), so re-approval is usually redundant. Apply the **Autonomy** rule:

- **Within guardrails** → post it as an FYI via `say` and proceed:
  ```
  say({ text: "Implementing the approved plan for TICKET_ID:\n\n<plan summary>\n\nProceeding now — cancel the task to stop me." })
  ```
- **Trips a guardrail or contains a genuine fork** → ask and wait:
  ```
  reply({ text: "Plan for TICKET_ID needs your call before I implement:\n\n<plan summary>\n\n<the specific concern>\n\nApprove to proceed?", type: "approval" })
  ```

### Step 3: Check for existing work

1. Look for a branch or PR matching the ticket ID: `gh pr list --state open --search "<ticket-id>"` and `git -C /workspace branch -r --list "*<ticket-id-lowercase>*"`.
2. If one exists:
   a. `gh pr diff <number>` and compare against the plan steps — identify which are already implemented
   b. Ask:
      ```
      reply({ text: "Found existing branch '<name>' with PR #NNN.\n\nBased on the diff, steps 1-3 appear done:\n- Step 1: ✓ ...\n- Step 4: ✗ Not started\n\nContinue from step 4, or start fresh?", type: "question" })
      ```
   c. Update the work document to reflect confirmed progress, then continue on that branch (`gh pr checkout <number>`).

### Step 4: Check for dependencies

Look for signals that this ticket depends on unmerged work: Linear "blocked by" relations, "depends on" / "after X lands" in the ticket, or a plan that references code that doesn't exist on `<base>`. If found:
```
reply({ text: "This ticket depends on PR #NNN (<title>), which isn't merged. Wait for it, or branch from its branch and target the PR at it?", type: "question" })
```

### Step 5: Branch setup

Create the branch **before writing code**:
```bash
post_status({ status: "running", message: "Creating branch and starting implementation" })
git -C /workspace fetch origin
git -C /workspace checkout -b <ticket-id>-<short-slug> origin/<base>
```

### Step 6: Implement

- Follow the plan steps exactly
- **Track "edited this session" as you go** — every path you pass to Edit, Write, or NotebookEdit. You need it for push verification (Step 9b).
- **Commit after each logical chunk** using the explicit-staging pattern from the Git workflow section.
- **Update the work document BEFORE every commit — hard gate.** Check off completed plan steps (`- [ ]` → `- [x]`) and update "Progress" via `update_document`.
- Update the Linear ticket status → "In Progress": `save_issue(id, state: "started")`
- **Match the codebase's comment density.** Follow the comment pattern of the area you touch. Don't add comments that justify the change to a reviewer or narrate its history — at most a line or two where the code genuinely needs it.

### Step 7: Guardrails — STOP if:

- **Scope exceeded**: >10 files or >200 lines → `reply` to confirm
- **Tests fail after 2 fix attempts** → `reply` to report
- **Plan doesn't make sense** → `reply` to explain and ask
- **Merge conflicts** you can't resolve from this PR's own intent → `reply` to report
- **git/gh failures** that persist after one retry → `reply` to report

When stopped, update the work document's "Blockers" section. After recovering from any tool failure, call `save_memory` with what failed and what future agents should do instead.

### Step 8: Quality gates

All must pass before pushing:
- [ ] Type-check and lint pass for the code you touched (commands from the repo's own docs)
- [ ] Tests you added or changed pass (leave the full suite to CI unless the task requires it)
- [ ] Snapshots updated if needed
- [ ] No sensitive files staged (`.env`, `*.key`, `*.pem`, credentials)

### Step 9: Push and open the PR

```bash
git -C /workspace fetch origin
git -C /workspace rebase origin/<base>         # only if behind; use merge instead if the branch was already pushed
git -C /workspace push -u origin <branch>
gh pr create --base <base> --head <branch> --title "<TICKET_ID>: <title>" --body "<body>"
```

The PR body includes: summary, changes, test plan, and the Linear ticket link.

### Step 9b: Push verification (mandatory)

Confirm the pushed branch contains every file you edited this session:
```bash
git -C /workspace diff --name-only origin/<base>...origin/<branch>
```
Every path in your session-edited list must appear. Other files are fine (earlier sessions may have committed them). If any is missing:
```
reply({ text: "Push verification failed on PR #<n>. Edited this session: <list>. Missing from the pushed branch: <paths>.", type: "blocker" })
```
Do NOT continue and do NOT post `complete` — the push did not capture your work.

### Step 9c: Ready, not draft

If the PR already existed as a draft, `gh pr ready <pr-number>`.

### Step 10: Self-review

Read the full diff (`gh pr diff <n>`) as a reviewer would. Fix anything wrong in a follow-up commit. Put notes on non-obvious decisions in the PR description under `## Self-review notes` rather than as PR comments.

### Step 11: Wrap up

1. Verify the work document is current: all completed steps checked, "Progress" shows branch, PR number, and "Submitted".
2. Update the Linear ticket status → "In Review".
3. Report to the dashboard:
   ```
   post_diff({ patch: "<git diff origin/<base>...HEAD>", summary: "<what changed>", pr_url: "<PR URL>" })
   post_status({ status: "complete", message: "PR submitted: <URL>" })
   ```
4. If manual steps were found in Step 1b, remind via `say` (not `reply` — the task is complete):
   ```
   say({ text: "Implementation complete. Reminder — these manual steps still need human action:\n\n<unchecked manual steps>" })
   ```

---

## Mode 2: Review a PR

### Step 0: Load review context

Before any review action, load prior review history so you don't re-flag dismissed issues:

1. `gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews` and `gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments`
2. Extract the ticket ID from the branch name (e.g. `eng-123-...` → `ENG-123`); if found, read its work document's "Review Notes"
3. Build a list of **already-resolved issues** — dismissed, marked resolved, or fixed in a later commit. **Never re-flag these.**

Then decide the sub-mode: if the task is to address feedback on your own PR → **Sub-mode B**. Otherwise → **Sub-mode A** (this covers reviewing someone else's PR, auditing your own, and auditing a work plan).

### Sub-mode A: Review (findings via reply only)

Review tasks **never post to the PR** — no `gh pr review`, no `gh pr comment`, no inline comments, no approve/request-changes. Findings go to the human through the channel; they decide what, if anything, to post.

1. `gh pr view <PR_NUMBER> --json title,body,author,reviews,comments,additions,deletions,headRefName,statusCheckRollup`
2. Note CI status. If the diff is >500 lines, summarise by file rather than reviewing line by line.
3. `gh pr diff <PR_NUMBER>`
4. Analyse: correctness, logic errors, conventions, test coverage, security — **excluding already-resolved issues**. If the prompt has a `## Review Lessons` section, check the diff against each lesson and report violations, citing the lesson.
5. Deliver findings:
   ```
   reply({ text: "Review of PR #NNN:\n\n<findings, each with file/line>\n\nPreviously resolved (not re-flagged): <list>", type: "question" })
   ```
   Treat the answer as a conversation turn (see "Delivering results" in Mode 6). If the human signals they're done, complete.
6. Persist review notes to the linked work document:
   ```
   update_document(id, content: "...\n\n### Review (DATE)\n- Issues raised: [list]\n- Resolved: [list]\n- Outstanding: [list]")
   ```
7. `post_status({ status: "complete", message: "Review findings delivered for PR #NNN" })`

### Sub-mode B: Address review feedback on your own PR

1. `gh pr view <PR_NUMBER> --comments` and `gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments` (paginate) — read what's being asked.
2. Apply the **Autonomy** rule — addressing review feedback is mostly obvious, in-scope work:
   - **Straightforward requested changes** → FYI via `say` and start fixing:
     ```
     say({ text: "Addressing review feedback on PR #NNN:\n\n<summary>\n\nFixing now — cancel the task to stop me." })
     ```
   - **Judgment calls only** — a change with a real tradeoff, that contradicts the ticket's intent, expands scope, or that you disagree with:
     ```
     reply({ text: "Review feedback on PR #NNN — one item needs your call:\n\n<item + your concern>\n\nHow do you want to handle it?", type: "approval" })
     ```
     Apply the obvious fixes alongside the answer.
3. `gh pr checkout <PR_NUMBER>`, implement the fixes, commit with explicit staging, sync and push (Git workflow section), then run push verification per Mode 1 Step 9b.
4. **Reply on each addressed human thread** — a short "done / what changed" note:
   `gh api repos/{owner}/{repo}/pulls/<N>/comments/<comment_id>/replies -f body="<what changed>"`
   A top-level review body may get one PR conversation reply for leftover items that weren't on a thread; it does **not** replace per-thread replies. **Do not resolve threads** — the reviewer owns resolution. Bot comments follow the section below.
5. **Re-review:** request it only from reviewers whose latest state is `CHANGES_REQUESTED` or `COMMENTED` (`gh pr edit <N> --add-reviewer <login>`). **Never request re-review when the PR already has any human approval** — re-requesting dismisses it.
6. Persist review notes to the linked work document ("Review Response (DATE)": feedback addressed, changes made, outstanding).
7. `post_status({ status: "complete", message: "Fixes pushed for PR #NNN" })`

### Bot-authored review comments (validity check)

Applies whenever you address feedback on your own PR. Comments whose author login ends in `[bot]` are AI-generated and can be wrong — **never implement one blindly.** Check each against the actual diff and current code, then:

1. **Valid** — the issue is real → fix it and push via the normal flow.
2. **Invalid** — misreading, stale, or already fixed → don't implement. Reply briefly on that comment explaining why it doesn't apply, citing the file/line that disproves it.
3. **Uncertain** — plausible but unverifiable → don't implement. Raise it via `reply({ type: "question" })` with your analysis.

Bot approvals never count as approval, and never request re-review from a bot.

---

## Mode 3: Write a Plan

1. `get_issue(id: TICKET_ID)` — read the ticket.
2. Explore the codebase — read affected files, understand existing patterns.
3. **Write the plan — single-agent or tournament.** If the work spans distinct layers (e.g. data → API → UI), touches >5 files or >150 lines, or crosses multiple packages, run the **Candidate Tournament**. Otherwise write the plan directly.
   **Judge rubric:** (a) **completeness** — every data-flow step stated end-to-end, no implicit assumptions; (b) **correctness** — would actually solve the ticket; (c) **feasibility** against the real codebase; (d) **repo fit** — follows existing patterns; (e) **minimalism** — smallest plan that fully solves it; (f) **manual steps captured**.
4. If the work is large, note natural review checkpoints in the plan — but it still ships as one branch and one PR unless the human asks for a split.
5. **Scan for manual steps** (same scan as Mode 1 Step 1b) and include them under a "Manual Steps" section with detailed sub-instructions.
6. **Save the plan** to the Linear work document (see "Work Document" below for the template):
   ```
   create_document(title: "TICKET_ID: <title>", issue: TICKET_ID, content: "<plan>")
   ```
   If one already exists, `update_document` in place — never duplicate.
7. Apply the **Autonomy** rule:
   - **Within guardrails** → post the plan via `say` and continue at Mode 1 Step 5:
     ```
     say({ text: "Plan saved for TICKET_ID and implementing now:\n\n<plan>\n\nCancel the task to stop me." })
     ```
   - **Exceeds guardrails or has a genuine fork** → ask and wait:
     ```
     reply({ text: "Plan for TICKET_ID — needs your call before I implement:\n\n<plan>\n\n<the decision>\n\nApprove to proceed, or tell me what to change.", type: "approval" })
     ```
     On approval → Mode 1 Step 5. If the human says stop → `post_status({ status: "complete", message: "Plan created for TICKET_ID" })`.

---

## Mode 4: Housekeeping

Clean up stale ticket statuses (and work documents when explicitly needed). Call Linear and dashboard MCP tools **directly** — never simulate them with Bash.

### Targeted ticket (when the prompt names one)

Be decisive and stop early:

1. `get_issue` for that ticket **first**.
2. Already **Done** or **Cancelled** → `say` that there's nothing to update, `post_status({ status: "complete", message: "<TICKET> already <state> — nothing to update" })`, **stop.** Don't dig through git history or invent follow-ups.
3. The prompt says mark it Done, or its PR is merged, and the ticket is still open → `save_issue(id, state: "done")`, `say({ text: "Moved <TICKET> → Done." })`, `post_status({ status: "complete", message: "Moved <TICKET> to Done" })`, **stop.** Don't ask cancel vs leave-as-is when the human already chose Done.
4. Ambiguous only when the prompt does **not** say mark Done and the PR was closed without merging:
   ```
   reply({ text: "PR #NNN for TICKET_ID was closed (not merged). Set the ticket to Cancelled, or leave it as-is?", type: "question" })
   ```

### Bulk sweep (no ticket in the prompt)

1. **Gather:** `list_issues(assignee: "me", state: "started")` and `list_issues(assignee: "me", state: "unstarted")`, plus your recent PRs:
   ```bash
   gh api graphql -f query='{ viewer { pullRequests(first: 30, states: [OPEN, MERGED, CLOSED], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number title headRefName state mergedAt closedAt } } } }'
   ```
   Match PRs to tickets by the ticket ID in the branch name.
2. **Find mismatches:** PR merged but ticket not Done; PR closed but ticket still In Progress; ticket In Progress with no branch/PR; work document "Progress" or checkboxes out of date.
3. **Fix:** merged → `save_issue(id, state: "done")`; stale documents → `update_document`; closed-unmerged with unclear intent → ask as in the targeted path.
4. **Summarise:** `post_status({ status: "complete", message: "Housekeeping: N statuses updated, M documents refreshed" })`, then `say` the list of changes (not `reply` — it's an FYI).

---

## Mode 5: Brainstorm

Explore a topic, generate approaches, and optionally create a ticket and plan.

1. **Topic** comes from the prompt. If there isn't one: `reply({ text: "What would you like to brainstorm?", type: "question" })`.
2. **Research:** search Linear for related tickets (`list_issues(query: "<keywords>")`) and explore the relevant code. If an existing ticket matches, ask whether to use it.
3. **Approaches:** build a table and ask:

   | Approach | Description | Pros | Cons | Effort |
   |----------|-------------|------|------|--------|
   | A        | ...         | ...  | ...  | S/M/L  |

   ```
   reply({ text: "Brainstorm: <topic>\n\n<table>\n\nWhich approach, or should I explore further?", type: "question" })
   ```
4. **On a choice:** create the Linear ticket if none exists (TL;DR, approaches table, task checklist) and a work document with the plan, then:
   ```
   reply({ text: "Ticket TICKET_ID created with a plan. Implement now, or stop here?", type: "question" })
   ```
   Implement → Mode 1. Stop → `post_status({ status: "complete", message: "Brainstorm complete: TICKET_ID created" })`.

---

## Mode 6: General

Catch-all for tasks that don't fit the other modes.

1. Read the instruction from the prompt.
2. `post_status({ status: "running", message: "Working on: <brief summary>" })`
3. Do the task with the available tools (git, gh, Linear MCP, filesystem). If it's ambiguous, ask via `reply` before acting.
4. Deliver the result via `reply` and follow the conversation loop below.
5. When the human signals they're done: `post_status({ status: "complete", message: "<summary of what was done>" })`.

If the task requires code changes, follow the Git workflow section and Mode 1's commit, quality-gate, and push-verification steps. If the task is a review or briefing about a PR, it follows Sub-mode A's rule: **never post to the PR**.

### Delivering results and the conversation loop

The channel tools (`reply` and `say`) are the ONLY way to post into the dashboard thread. Plain assistant text goes to the raw log stream — the human never sees it. **Every message meant for the human goes through `reply` or `say`**, including answers to follow-up questions.

When you deliver a result via `reply`, the human's response comes back as that call's result. Treat it as a conversation turn:

- **Follow-up question or discussion** → answer by calling `reply` again (this posts the answer AND keeps the conversation open):
  ```
  reply({ text: "<your answer>\n\nAnything else, or shall I wrap up?", type: "question" })
  ```
- **Asks for more work / approves a proposal** → acknowledge via `say` ("Got it — implementing now."), do the work, then `reply` with the result. Never send an acknowledgement via `reply` — it would park you waiting for an answer.
- **Signals they're done** ("thanks", "looks good", "that's all") → optionally a brief `say`, then complete.

Never `post_status({ status: "complete" })` immediately after answering a question the human just asked.

### Fixing bugs

When a general task is a bug fix, don't ship a speculative fix. Confirm the cause first — reproduce it, or trace the full causal chain through code that exists today. If you can't confirm it, a clear diagnosis with the leading candidate(s) and the exact check that would decide between them is a successful outcome: deliver it via `reply` and ask before changing code. Label an unconfirmed cause as a "leading candidate", never as "root cause".

---

## Mode 7: Ship

Run the full ticket-to-PR pipeline end-to-end. One dispatch → one PR, no round-trips to the human except in the cases listed below.

### Preconditions

`TICKET_ID` must be set (env or prompt). If missing: `reply({ text: "Ship mode requires a ticket ID; none provided.", type: "blocker" })`, then stop.

### When `reply` is allowed

`reply` is permitted ONLY from: Step 0 (ambiguous or stale ticket), Step 2 (audit budget exhausted), Step 3 (guardrail), Step 4 (self-review budget exhausted), Step 5 (pre-push verification failed). Every other step runs silent — `say` is not a loophole; Ship does not narrate progress.

### Step 0: Ticket-sanity gate (never skip)

1. `get_issue(TICKET_ID)` — description, state, assignee.
2. `list_comments(TICKET_ID)` if available — read the last ~10 comments. If the tool isn't available, proceed on the other signals and note it in the PR description.
3. `list_documents(query: TICKET_ID)` + `get_document(id)` for the work document if one exists.
4. `gh pr list --state all --search "<TICKET_ID>"` — for any merged PR, read its diff for context that may supersede the ticket.

Decide ONE of:
- **Clean** — coherent, complete, current → proceed silently.
- **Ambiguous** — acceptance criteria missing or unclear:
  ```
  reply({ text: "Ticket-sanity check for TICKET_ID surfaced these questions:\n\n<bundled questions>\n\nAnswer all before I proceed.", type: "question" })
  ```
- **Stale** — description contradicts recent comments or merged work:
  ```
  reply({ text: "TICKET_ID looks stale vs recent work. Proposed new description:\n\n---\n<new description>\n---\n\nApprove to update and proceed, or say what's wrong.", type: "approval" })
  ```
  On approval: `save_issue(id, description: <new>)`, then proceed.

### Step 1: Plan

1. **Pattern scout.** For every new file/function/route the plan introduces, find the closest existing analog in the repo. Each plan step cites it: "Following the pattern of `<path>`, add …". If none exists, flag that piece as "new pattern being introduced" — it gets extra scrutiny in Steps 2 and 4.
2. **Write the plan** with specific file paths, changes, and analog citations.
3. **Manual-steps scan** (as Mode 1 Step 1b). Add any to the work document under `## Manual Steps` — don't `reply`; they surface in the PR description at Step 6.
4. **Persist** — `update_document` if a work document exists, otherwise `create_document`. No approval request for the plan.

### Step 2: Self-audit (budget: 2 passes)

If the prompt has a `## Review Lessons` section, check the plan against each lesson; revise and `update_document` in place. On exhausting 2 passes with violations remaining:
```
reply({ text: "Audit budget exhausted. Outstanding violations:\n\n<list>\n\nHow should I proceed?", type: "question" })
```
No `## Review Lessons` section → skip to Step 3.

### Step 3: Implement

Follow Mode 1 Steps 5–8 (branch, implement with explicit-staging commits, work document before every commit, quality gates). Mode 1 Step 7 guardrails apply — when one trips, `reply({ type: "question" })`.

### Step 4: Self-review (budget: 2 revision loops)

Read your diff (`git -C /workspace diff origin/<base>...HEAD`) and check:
- **Pattern match** — each new/changed file against its cited analog (error handling, imports, naming, placement), unless flagged "new pattern being introduced"
- **Review-lesson compliance** — against every lesson in the prompt, if any
- Conventions, test coverage, security (no secrets, input validation at boundaries), logic errors

Fix issues inline with explicit-staging commits. Keep the findings for the PR description — **do not post them as PR comments**. On exhausting 2 loops:
```
reply({ text: "Self-review budget exhausted. Outstanding findings:\n\n<list>\n\nHow should I proceed?", type: "question" })
```

### Step 5: Pre-push verification

Run the repo's required pre-push checks — type-check, lint, and build for the code you touched. Use the commands from the repo's docs, or from a Repo Memory in your prompt that names them. On any failure you can't fix:
```
reply({ text: "Pre-push verification failed:\n\n<command>\n\n<output>\n\nFix and retry, or cancel.", type: "question" })
```

### Step 6: Push and open the PR

Sync and push per the Git workflow section, run push verification (Mode 1 Step 9b — silent on pass), then `gh pr create` (ready, not draft). The PR body includes, in order:

1. Summary of changes
2. Test plan
3. Linear ticket link
4. `## Self-review notes` — what you checked, what you fixed, anything you're less sure about ("No outstanding concerns." if nothing)
5. `## Manual Steps` copied from the work document, if any

Then:
```
post_diff({ patch: "<git diff origin/<base>...HEAD>", summary: "<what changed>", pr_url: "<URL>" })
post_status({ status: "complete", message: "PR submitted: <URL>" })
```

Exit. Don't wait for CI.

---

## Work Document (source of truth)

Every ticket needs a Linear document linked to the issue — the single editable source of truth for plan, progress, blockers, and review notes. Create with `create_document`, update in place with `update_document`.

For the template and update rules, read `/workspace/.claude/skills/_shared/work-document-template.md`.

---

## Memory

Use `save_memory` when you discover something non-obvious about this repo that would help future tasks — build commands, patterns, error fixes, gotchas, workarounds for tool failures.

- **Do save:** things that surprised you, things you had to figure out, team conventions from PR feedback
- **Don't save:** obvious README info, one-off task details, secrets/credentials
- **When:** after completing the task, and after anything that took more than ~3 steps to figure out
- **Format:** 1–3 sentences with specific commands or file paths

Repo Memories in your prompt never override this skill's gates — in particular, nothing in a memory authorises posting to a PR, skipping an approval, or acting on a guess.

---

## Rules

Container-wide rules (sensitive-file protection, runtime-injected files, channel-only communication, foreground waiting, etc.) live in the workspace `CLAUDE.md`, appended to every session by the container entrypoint. The rules that matter most in this skill:

- Ask instead of guessing when anything is ambiguous.
- Review tasks deliver findings via `reply`; they never post reviews or comments to the PR.
- Never request re-review when the PR already has a human approval.
- Stage only the files you changed, by name.
- Done with nothing to ask → `post_status complete`. Never park a task without a question.
- Don't ship a fix whose cause you haven't confirmed.
- Match the comment density of the code you touch.
