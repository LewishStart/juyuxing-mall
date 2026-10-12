---
name: juyuxing-mall-debug
description: Debug build, UI, simulator, or cloud-call symptoms in the Lin Yuanyuan Mall WeChat Mini Program. Use when a user asks to debug, diagnose, investigate, explain, or explicitly repair a symptom in this repository.
---

# Lin Yuanyuan Mall Debug

Read `../juyuxing-mall-project.md` before acting. Apply this skill only when its repository markers match the current workspace. Reuse an active WeChat DevTools project; when readiness evidence is absent, direct the user to `$juyuxing-mall-bootstrap` first.

## Diagnose

Diagnose by default. Do not edit source, configuration, lockfiles, or cloud state unless the user explicitly requests a repair.

1. Capture the symptom, expected result, affected route, simulator state, and timing or reproduction steps.
2. Gather the DevTools console output, relevant source, and the narrowest applicable local check from the shared reference.
3. For a timeout, locate its request or cloud call in Network or Console. If it cannot be located, reproduced, or supported by local evidence, state the limitation and request only the minimum missing evidence, such as the request or call name or a Console stack. Do not speculate about cloud causes or change state.
4. Classify every console finding as a blocking error, compatibility warning, or expected environment condition.
5. State the evidence, most likely cause, confidence or remaining uncertainty, and the next safe action. Keep user changes intact.

## Explicit Repair

For an explicit repair request, use the smallest scoped change. First add or select an executable focused check where practical and demonstrate the failure. Make the minimum repair, rerun that focused check, then run the relevant project checks. Explain any check that cannot be automated.

## Completion And Stops

For diagnosis, complete with evidence-backed classification and a safe next action. For repair, complete only after reporting the edit, focused verification result, and relevant broader check result.

Stop and ask the user to complete QR login, AppID membership, CloudBase authorization, or operating-system installation confirmation. Never deploy a function, seed or write cloud data, invoke `init`, start or test real payment, upload a release, or perform remote actions while diagnosing.
