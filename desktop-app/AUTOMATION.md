# Automation

One application-wide configuration lives in the app config directory as
`automation.json`. It is independent of message presets and autosaves validated
changes through a serialized write queue. A temporary file is renamed over the
previous configuration. Browser preview uses local storage instead. Invalid
input remains visible with an explanation and does not overwrite saved settings.

The saved configuration is captured when `start_campaign` dispatches the queue.
Running campaigns retain their snapshot. The frontend flushes pending saves
before launching. Defaults are shared in `browser-runtime/automation-defaults.json`.

Each profile independently applies a random delay within the configured range,
a confirmed-send limit, and an additional series break (whichever delay is
longer). Only confirmed sends count toward limits and series. Pending jobs past
the limit remain untouched. No additional parser batch is fetched automatically.

Count-based inbox checks run between sends. Time-based checks are enabled only
in monitor mode after the send limit or end of the queue; their interval is in
seconds. The interval field is disabled with an explanation in finish mode.
Legacy minute values migrate to seconds without changing their duration.
Captured metadata uses small chunks and fresh run IDs for the inbox baseline
endpoint. Initial parser and baseline references remain intact. This prepares
reply candidates but does not send automatic replies.

After completion or reaching the limit, `finish` ends the profile queue and
`monitor` checks incoming mail at the configured second interval until stopped.
Zero disables a count/time check or series break. A zero send limit means the
entire received queue. Monitor requires a nonzero time interval. Waiting polls
stop state at most every 250 ms; closing the browser cancels active browser work.

## Continue after an uncertain send

An outbound `send_unconfirmed` outcome is saved as `unknown` and skipped while
processing the remaining jobs. Send is never clicked again for that job. Before
the next job (or inbox monitoring), Gmail reloads without discarding uncertain
drafts, rechecks the mailbox, and refuses to continue if a composer remains open.
Possible sends count toward delay, series and per-profile limits, but never toward
confirmed sent counters. Missing outcome persistence, account changes and other
sending errors still halt the profile.

Scheduled inbox capture retries transient loading/network timeouts up to three
attempts with 2/5-second backoffs and Gmail reloads. Exhausted transient capture
skips only that check; monitoring waits until its next scheduled interval. Account
changes, closed browsers, API failures and reply-processing errors remain fatal.
