# Repository Guidelines

## Project Structure & Module Organization

This repository contains the Lin Yuanyuan WeChat Mini Program and its CloudBase backend. `miniprogram/` is the client: each feature page lives in `pages/<feature>/` with matching `.js`, `.json`, `.wxml`, and `.wxss` files. Shared client code belongs in `miniprogram/utils/`, reusable components in `miniprogram/components/`, styles in `miniprogram/style/`, and images in `miniprogram/images/`.

`cloudfunctions/<function>/index.js` contains one deployable CloudBase function, with its own `package.json`. Configuration is in `project.config.json`, `cloudbaserc.json`, and `database-indexes.json`. `admin-web/` is an admin prototype; `scripts/` holds verification and setup tools.

## Build, Test, and Development Commands

- `npm install` installs root tooling dependencies.
- `npm run smoke` runs static checks and business-rule assertions. It requires valid AppID and CloudBase environment settings.
- `node scripts/e2e-mock.js` runs the mocked end-to-end flow without connecting to CloudBase.
- `npm run lint:functions` syntax-checks every `cloudfunctions/*/index.js` file.
- `npm run setup` checks deployment configuration and installs missing production dependencies in each cloud function.

Import the project in WeChat DevTools to compile and preview it. Deploy cloud functions from the CloudBase panel after local checks pass.

## Coding Style & Naming Conventions

Use JavaScript with 2-space indentation, single quotes, semicolons, and `'use strict';` in Node-based scripts and cloud functions. Keep Mini Program pages grouped by feature and name directories with lowercase kebab case, such as `pages/order-detail/`. Keep the four page files aligned to the same basename. Use camelCase for variables and functions, and make cloud-function actions explicit (for example, `createOrder` or `updateStatus`). Reuse tokens from `miniprogram/style/tokens.wxss` rather than introducing page-local palette values.

## Testing Guidelines

Add or extend checks in `scripts/smoke-test.js` for changed business rules. Changes spanning a customer workflow or cloud functions should also update `scripts/e2e-mock.js`; run both scripts plus `npm run lint:functions`. In WeChat DevTools, manually verify affected pages, loading/error states, and the relevant payment, order, or authorization path.

## Commit & Pull Request Guidelines

The current history uses Conventional Commit prefixes, for example `feat: complete payment flow` and `chore: initial project`. Keep commits focused and use `feat:`, `fix:`, `test:`, `docs:`, or `chore:`. Pull requests should state the user-visible impact, identify CloudBase/database or configuration changes, link the issue when available, list commands run, and include screenshots or a short recording for UI changes.

## Configuration & Security

Never commit credentials, payment keys, or personal OpenIDs. Keep the CloudBase environment ID consistent between `miniprogram/app.js` and `cloudbaserc.json`; validate cloud-function input and authorization server-side before reading or writing data.
