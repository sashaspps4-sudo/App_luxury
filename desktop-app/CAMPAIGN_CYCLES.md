# Campaign cycles

The desktop uses one coordinator for all browser profiles. Browser contexts remain
independent: a failed or manually closed profile is removed from future requests.

For each active profile the next parser quota is the smaller of the cycle size
(`checkEverySent`) and its remaining run limit (`maxPerProfile`). The upstream
request limit is exactly the sum of these quotas. If `checkEverySent` is zero,
inbox checks during sending are disabled and batches contain up to 10 ads per
profile. A zero run limit means continuing until the parser is exhausted.

The server distributes a short result in round-robin order without exceeding
individual quotas. After sending its assigned ads, each profile checks incoming
mail and processes eligible replies. The coordinator waits for all participating
profiles before requesting another batch. Profiles reaching their run limit are
excluded; their configured finish/monitor action runs independently.

Confirmed and uncertain sends consume the run limit. Only confirmed sends count
as sent in statistics. Counters, pacing, and series pauses persist between batches
and reset on a new launch. Subject/text rotation continues across batches.

Each parser batch has a unique ID; subsequent batches reference the original run.
Outbound reservations use the original run and mailbox baseline, with an explicit
batch ID. Parser replays return the persisted result. The server excludes already
assigned addresses within the campaign and recipients with sent/sending/unknown
outcomes from previous campaigns, across profiles. Claiming a second concurrent
send to an already reserved recipient is also rejected.

An empty usable result triggers at most three additional parser calls, spaced by
five seconds, within a 70-second overall server budget. A short nonempty result
is sent immediately. Exhaustion after retries ends sending; timed inbox checks
start only if `afterQueue` is `monitor`. Errors such as authentication, payment,
rate limits, and malformed upstream results are errors, not empty successes.
The API proxy allows 75 seconds for this route. Stopping the desktop aborts its
pending shared parser request and closes the browser contexts.

Coverage includes five profiles with 10+10+5 sends, uneven short batches, empty
initial/subsequent batches, monitoring enabled/disabled, unknown outcomes, fresh
run counters, stop during a parser request, cross-cycle mailbox binding, dedup,
parser idempotency, and exclusive outbound claims. Tests use synthetic mail;
they do not send real Gmail messages or consume a paid parser key.
