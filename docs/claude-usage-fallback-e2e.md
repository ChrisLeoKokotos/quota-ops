# Claude Team Usage collection — Windows E2E verification

This experimental collector change addresses the observed `unsupported /
claude_page_api_not_observed` result even when the **same isolated profile**
shows real quotas in Settings > Usage.

## What changed

- Claude response interception is attached to the Playwright **browser context**
  rather than only one page. The parser still accepts only the exact
  `claude.ai` organization/usage endpoint.
- **Owner E2E evidence:** Windows `collect dev-1` in headless mode still
  returned `unsupported`, while `collect dev-1 --visible` returned `ok`,
  both values at 100%, with real reset timestamps. Therefore regular Windows
  collection now uses headed Chrome/Edge with minimized/offscreen window flags,
  as a testable hypothesis, rather than the failing headless launch. This is
  normal authenticated page loading, **not** a challenge or auth bypass.
  Offscreen behavior still requires real-world confirmation.
- If that response is not observable, the collector checks the freshly rendered
  Settings > Usage panel, within the *same authenticated browser profile*.
  Only a complete, labelled **Current session** and **All models** percentage
  pair is accepted; absent or ambiguous values remain `unsupported`.
- The UI fallback **does not calculate reset timestamps**. It returns
  `resetAt: null` and a message describing the data source.
- `--visible` is an opt-in CLI diagnostic for Claude. Background runs remain
  headless. No cookies, tokens, response bodies or full-page text are logged.
- Neither option bypasses sign-in, challenge pages or provider controls.

## Safe verification on Windows 11

First, close any QuotaOps-owned browser window opened by `login` and stop the
background collector temporarily so the same Chrome profile is not in use.
After updating the branch, run `npm run typecheck` and `npm test` before E2E.
On Windows the default command now launches normal Chrome/Edge in a minimized,
offscreen mode. A brief window flash may still occur; do not assume invisible
collection is guaranteed on all machines.

In the VS Code terminal:

```powershell
npm run collector:setup -- collect dev-1
```

If the result is still `unsupported`, compare with an explicitly **visible**
collection:

```powershell
npm run collector:setup -- collect dev-1 --visible
```

Observe whether Settings > Usage renders in the visible collection window.
Do **not** copy output containing cookies or session credentials. Report only
the `status`, reason (if any), percentages and whether reset timestamps are
`null`. Never publish browser profile contents.

### Expected classifications

- `status: "ok"` with numeric percentages: UI/API read succeeded. Compare to
  the provider's visible page at that time. A DOM fallback has null reset times.
- `login_required`: must sign in normally; don't infer a quota.
- `unsupported`: no sufficiently reliable pair of usage windows found.
- `unavailable`: browser or navigation failed; do not delete the profile.

Do not treat synthetic/unit tests as evidence that real Windows authentication
works. Keep this PR Draft until local and hosted checks pass, the owner confirms
a real collection, and the required security review is complete.

## Known limitations

The Claude web UI and its internal requests are not a stable public API. The
fallback deliberately accepts only the observed English Team Usage layout and
will refuse alternate layout text rather than guessing. It cannot infer exact
absolute reset timestamps from locale-dependent labels. This is a temporary,
conservative fallback, not a replacement for a documented provider API.
