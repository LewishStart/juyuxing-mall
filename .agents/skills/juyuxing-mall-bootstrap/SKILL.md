---
name: juyuxing-mall-bootstrap
description: Bootstrap the Lin Yuanyuan Mall WeChat Mini Program for safe local debugging. Use when a user asks to bootstrap, prepare, open, compile, or verify local readiness for this repository's Mini Program.
---

# Lin Yuanyuan Mall Bootstrap

Read `../juyuxing-mall-project.md` before acting. Apply this skill only when its repository markers match the current workspace.

## Ready

Use `ready` by default. Do not install dependencies unless they are absent or unusable; request approval before any download.

1. Confirm the repository identity and report the current Git worktree state without changing it.
2. Check the installed Node version and whether root dependencies already exist.
3. Read the configured AppID and CloudBase environment values. Confirm the stable configuration relationship described in the shared reference; report mismatches without rewriting configuration.
4. Run `npm run lint:functions`.
5. Reuse an active WeChat DevTools project when possible. Otherwise open/import this repository, set the active route to `pages/index/index`, and compile it.
6. Report the active route, simulator state, cloud-initialization state, blocking console errors, and non-blocking warnings separately.

If `npm run lint:functions`, DevTools import, or compilation fails, report the failed step and its exact blocking output. Do not claim readiness or enter `full verify`; make any repair or change only after the user explicitly requests or approves it.

If dependencies must be installed, show the proposed command and wait for approval. When installation modifies a lockfile, identify every affected path, leave the changes visible and unstaged, and do not overwrite an existing user edit.

## Full Verify

Enter `full verify` only when the user explicitly requests it, dependencies were installed in this run, or `ready` found an abnormal state. Run the shared reference's smoke and mocked E2E commands. Keep this branch local; it must not contact or change CloudBase.

## Completion And Stops

Complete only after reporting either a compiled `pages/index/index` session or the precise blocking prerequisite, plus every local check run and its result.

Stop and ask the user to complete QR login, AppID membership, CloudBase authorization, or operating-system installation confirmation. Never deploy a function, seed or write cloud data, invoke `init`, start or test real payment, upload a release, or change application code, configuration, or lockfiles.
