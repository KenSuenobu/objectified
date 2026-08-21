---
name: implement
description: Fetches the GitHub Issue for the current repo, implements the work to be done.
---

# Implement (`/implement <number>`)

When user invokes **implement** with issue number, treat number as **GitHub issue** in **current repository**. Follow workflow end to end unless user terminates or environment blocks (auth, permissions, missing `gh`, etc.).

## Guidelines

- Apply **AGENTS.md**
- Only change what ticket requires: avoid unnecessary refactors.
- Never commit credentials or tokens.
- If blocked, stop, explain.

## Phase 1: Fetch issue

- Identify current repository from workspace context.
- Fetch full issue **title, body, labels, and any linked/previous discussion**:

```
gh issue view <number> --repo <owner>/<repo>
```

- Summarize issue clearly in conversation so full intent in context.
- **NEVER invent requirements.**  If issue **ambiguous, underspecified, or contradicts the codebase**, SWITCH TO PLAN MODE, clarify, and stop.

## Phase 2: Branch setup

- Fetch and checkout latest default branch:

```bash
git checkout main
git pull origin main
```

- Create and switch to `ticket-<number>`:

```bash
git checkout -b ticket-<number>
```

- If branch already exists, report it and ask whether to reset or reuse.
- All implementation commits for ticket belong on this branch.

## Phase 3: Implementation

- Implement behavior **as specified in issue**, do not deviate.
- If description is **large or risky**, SWITCH TO PLAN MODE, outline a short plan in chat.
- Split code into separate modules, helper functions, or utility classes if context too large.
- Keep implementation **simple** - keep code easy to read and understand, fully document methods, inputs, and return variables.
- Create **comprehensive test cases** for all new and changed functionality.
- UI: Create integration UI tests when working on UI/UX features.
- Lint the code.

## Phase 4: Internal Audit

- Ensure potential misuses of new code are safeguarded, covered, noted.
- UI: Use **CSS classes** - no hard-coded values.
- Documentation must be complete and simple.
- Check for code reuse; extract repeated logic into separate reusable modules.
- Tests must run unit tests only, e2e and integration is done via CI/CD, so is not necessary here.

## Phase 5: Verify and Test

From **repository root**, run project's standard checks:

- Build project:

```bash
yarn build
```

Run package-specific builds required by workspace rules.

- Run tests:

```bash
yarn test
```

Run package-specific tests the issue touches, per READMEs.

- Test unit tests
- Fix **any failures introduced that block ticket** and **any tests or build issues** before proceeding.

## Phase 6: Note Work

- Mark ticket complete in **ROADMAP** and REMOVE ITS ENTRY FROM THE ISSUES TABLE matching the issue number if applicable.
- Bump semver versions in modified projects.

## Phase 7: Commit, Push, Pull Request

### Commit

```bash
git add -A
git commit -m "Fix #<number> - <concise title>"
```

### Push

```bash
git push origin ticket-<number>
```

### Open the PR

Use `gh` to create Pull Request from `ticket-<number>` into default branch:

```bash
gh pr create \
  --title "Fix #<number> - <concise title>" \
  --body "<descriptive body>" \
  --base main \
  --head ticket-<number>
```

#### PR body must include:

- What was done and why
- How to test
- Risk/notes
- Issue link: `Closes #<number>` (or `Fixes #<number>`)
- Notate: `Made with <agent name> using model <model name>`

## Phase 8: Explain How to Test

- Note how to test what was done.
- Include steps with each important piece boldfaced (e.g. "**click button X**" or "**browse to Y**")
- Note example data to put into forms to test.

## Phase 9: Switch to Main

Switch back to `main`:

```bash
git checkout main
```

