# License session lifecycle

The desktop calls `/v1/auth/refresh` and reads `/v1/me` every minute, on window
focus, when connectivity returns, and at the last confirmed subscription expiry.
Successful checks update the displayed plan and expiry. The server remains the
authority: a stale local date cannot log out a subscription the server accepts.
Refreshing also extends the existing token's server lifetime (up to seven days,
bounded by the current subscription). Activation still revokes previous tokens.

HTTP 401/403 stops profile workers before removing the local token and returning
to login. Manual logout uses the same shutdown command before server logout.
`end_browser_session` sends stop to all workers, waits up to ten seconds, and
terminates remaining worker process trees on Windows. It closes the current run
without deleting saved browser profiles. If shutdown fails, exit is deferred
and retried; the user sees an explanation. Stale checks cannot clear a new login.

Network errors, server errors and timeouts do not invalidate stored sessions.
At startup a dedicated backend-unavailable screen offers retry, automatically
rechecks every thirty seconds, and retries when connectivity returns. During
work a connection notice appears while periodic validation continues. Default
API request timeout is fifteen seconds; endpoints with explicit timeouts retain
their own limits. Already initiated browser actions may finish before the worker
receives stop; the shutdown command waits for termination before leaving login.

Tests: `node --experimental-transform-types --test src/sessionLifecycle.test.ts src/licenseApi.test.ts`.

## Session status and elapsed time in Overview

The native run snapshot records `startedAtMs`; worker status transitions stamp
`endedAtMs` once all profiles are closed or failed. Late events from an earlier
run cannot finish a newer run. `active_browser_run` returns these timestamps and
campaign/stop flags, allowing the screen to reconstruct time after remounting.
Overview updates elapsed time every second, preserves the final duration after
closure, and resets it for a new run. Session labels follow live worker phases
and current preparation actions rather than the launch button stage.
