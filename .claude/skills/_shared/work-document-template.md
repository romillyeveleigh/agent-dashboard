# Work Document (source of truth)

Each ticket gets a **Linear document** linked to the issue. This is the single editable source of truth for all persistent state. Create with `create_document`, update in-place with `update_document`.

```
create_document(title: "ENG-123: Add search", issue: "ENG-123", content: "...")
```

## Template

```markdown
# ENG-123: Add search

## Implementation Plan
- [ ] Add search endpoint to the API
- [ ] Wire up the data layer
- [ ] Build the search UI component
- [ ] Add tests

## 🔧 Manual Steps
- [ ] **Short description of the step**
  1. Detailed sub-step (research what's actually needed at the time)
  2. ...
  3. ...

## Progress
Branch: (none yet)
PR: (none yet)
Status: Planning

## Blockers
(none)

## Review Notes
(none yet — updated after each review session)
```

## Update rules

- Check off plan steps as they're completed (`- [ ]` → `- [x]`) via `update_document`
- Update the "Progress" section at natural boundaries (PR opened, guardrail hit, end of session)
- Add blockers to "Blockers" when discovered, remove them when resolved
- Add manual steps when discovered; the user or Claude can check them off
- Append to "Review Notes" after each review session (given or received) — issues raised, what was resolved, what's outstanding
- Omit sections that don't apply (no "Manual Steps" if there are none, no "Review Notes" until the first review)
