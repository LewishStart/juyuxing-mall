# Lin Yuanyuan Mall Project Reference

Use this reference only from the Lin Yuanyuan Mall project-local skills.

## Identity

- Repository marker: root `package.json` names the package `juyuxing-mall`.
- Mini Program root: `miniprogram/`; home route: `pages/index/index`.
- Cloud functions: `cloudfunctions/`; project settings: `project.config.json`; CloudBase manifest: `cloudbaserc.json`.

## Local Commands

- Readiness check: `npm run lint:functions`.
- Full local verification: `npm run smoke` and `node scripts/e2e-mock.js`.
- Configuration check: compare the non-placeholder CloudBase environment in `cloudbaserc.json` with `globalData.envId` in `miniprogram/app.js`; inspect the configured non-placeholder AppID in `project.config.json`.

## User-Owned Cloud Boundaries

- Keep authentication, QR login, AppID membership, CloudBase authorization, and operating-system installation approval with the user.
- Do not deploy or upload cloud functions, create environments or collections, seed data, run the `init` cloud function, write remote data, invoke real payments, or upload releases.
- Preserve existing worktree changes. Do not reset, overwrite, stage, or normalize application configuration or lockfiles.
