# Application ports

The application layer depends on these structural interfaces; concrete adapters are wired in `main.js`.
No Express request, PostgreSQL client, SMTP transport or Better Auth object enters domain functions.

- **Repository**: `transaction(fn)`, `now()`, `daily(date)`, `createDaily(date,puzzle)`, `saves(userId)`, `leaderboard(filter)`.
- **Transactional repository**: `lockUser(userId)`, `run(id,userId)` (locks owned aggregate), `active(...)`, `createRun(...)`, `latestStage(runId)`, `stage(id)`, `createStage(...)`, `submission(requestId)`, `dailyById(id)`, `record(...)`, `abandon(id)`, `now()`.
- **Transit**: `generate(city,scenario)` returns a server puzzle with pinned data/rules versions and optimal time; `evaluate(puzzle,route)` returns route milliseconds or throws a domain error; `load(city)` returns data hash for leaderboard version scoping.
- **Mail** (authentication boundary): async `sendMail({to,url,kind})`; production SMTP and local preview implement the same signature.

Transactions serialize run changes via `SELECT ... FOR UPDATE`. `record` persists a settlement already decided by the domain, updates run progress, and projects verified results atomically. Leaderboards are read models over these results. Active runs themselves are cloud saves, so there is no independent mutable layer counter to synchronize.
