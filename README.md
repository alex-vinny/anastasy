# Anastasy — reversible SQL Server CLI (`dbq`)

Runs `SELECT / INSERT / UPDATE / DELETE` against SQL Server in a structured way
and keeps a **git-like undo journal**: every mutation records the prior state
(or the inserted PKs) so it can be **reverted**. Also runs **DDL**
(`CREATE / ALTER / DROP`) and arbitrary batches / procedure calls (`exec`), both
restricted to non-prod write connections — audited in the journal but **not**
auto-revertible (see [Safety](#safety)).

```
node index.js <command>
```

**Storage:** a local SQLite file (`dbq.sqlite`, via the built-in `node:sqlite`)
with three tables — `journal` (a gzipped row snapshot per mutation),
`schema_cache` (columns / types / PK / identity per table), and `result_cache`
(opt-in cached reads with a TTL).

## Requirements

- **Node.js 22+** (uses the built-in `node:sqlite`)
- `npm install` in this directory once (installs the `mssql` driver)
- Reachable SQL Server instance(s) and a connection string for each

## Setup

```bash
npm install
```

Connections live in **`.env`** (one ADO.NET connection string per line — see
`.env.example`):

```
HML=Data Source=...;Initial Catalog=your_db_hml;User Id=...;Password=...;Encrypt=true;TrustServerCertificate=true
```

Optional suffixes `<NAME>_READONLY=true|false`, `<NAME>_PROD=true|false`, and `<NAME>_DESC=<text>` (an explanation shown by `dbq conns`);
without them, `readonly`/`prod` are inferred (a *reader* user, or a db/server
whose name contains `prd|prod|pro-`). Readonly connections refuse mutations;
prod connections require `--force-prod`.

### Session password (credentials that expire)

A connection **without `Password=`** in its connection string uses a *session
password* — nothing is written to `.env`. At connect time the password is
resolved in this order:

1. the `DBQ_PASSWORD` environment variable (one-off override);
2. the `auth` cache in `dbq.sqlite` (with a TTL);
3. a hidden interactive prompt (when a TTY is present); with no TTY it errors
   and tells you to run `dbq auth`.

```bash
node index.js auth PRD                          # hidden prompt (terminal)
node index.js auth PRD --password '...' --ttl 60  # non-interactive, TTL in minutes (default 480)
node index.js auth PRD --clear                  # drop the cached credential early
```

`conns` shows the state: `auth: pending` / `auth ok until HH:MMZ` / `auth: EXPIRED`.
The cache stores the password base64-encoded (obfuscation, not encryption — the
same exposure level as `.env`, but with automatic expiry and outside a durable
config file).

### Azure AD / Entra ID — your own user with MFA (no password at all)

Add `Authentication=` to the connection string instead of `Password=`:

```
DEVAAD=Data Source=...;Initial Catalog=...;Authentication=Active Directory Interactive;User Id=you@company.com;Encrypt=true;TrustServerCertificate=true
```

| `Authentication=` value | How you sign in |
|---|---|
| `Active Directory Interactive` | `dbq auth DEVAAD` opens the browser; complete MFA once per device |
| `Active Directory Device Code` | `dbq auth DEVAAD` prints a URL + code; sign in from any device (also `--device` on any AAD conn) |
| `Active Directory Default` | `DefaultAzureCredential`: `az login`, Azure PowerShell, env vars or managed identity — nothing cached in dbq |

`User Id=` is only a **login hint**; `Tenant Id=` is optional (default `organizations`).
Token resolution order at connect time: `DBQ_TOKEN` env var (e.g. from
`az account get-access-token --resource https://database.windows.net/`) → cached
access token in `dbq.sqlite` (≈1 h) → **silent renewal** through the persisted MSAL
refresh-token cache (`@azure/identity-cache-persistence`, stored in the OS keychain /
DPAPI) → browser sign-in (only when a TTY is present; otherwise it errors and tells you
to run `dbq auth`). `dbq auth <conn> --clear` signs out.

The readonly/prod flags and every safety rule below apply exactly the same; you get
the permissions of your own account in that database, no more.

Nothing account-specific lives in the code: user (login hint), tenant, server and
database come only from the connection string in `.env` (gitignored, like `dbq.sqlite`).

**Status:** `Active Directory Interactive` is validated end to end against Azure SQL
Database (sign-in, cached token from a non-TTY shell, silent renewal after expiry).
`Device Code` and `Default` are implemented on the same code path but less exercised.

## Commands

| Command | What |
|---|---|
| `conns` | list configured connections and their flags |
| `schemas <conn> [--table T]` | list the schemas this database actually has (with `--table`: which schemas hold that table) |
| `query <conn> "<SELECT ...>"` | read-only SQL (`SELECT`/`WITH`, see [the read-only guard](#the-query-read-only-guard)) — `--cache [ttl]` to memoize; `--stats` for reads and server time |
| `select <conn> --table T [--schema s] [--where "..."] [--top N] [--columns "a,b"]` | structured SELECT |
| `count <conn> --table T [--where "..."]` | just the count (cheap in tokens) |
| `describe <conn> <table> [--schema s] [--refresh]` | columns/types (uses `schema_cache`) |
| `auth <conn> [--password <p>] [--ttl <min>] [--clear] [--device]` | cache a session password, or sign in with Azure AD (browser / device code) |
| `insert <conn> --table T [--schema s] --values '{json}' [--pk Id]` | insert (records inserted PKs). `--values '[{..},{..}]'` or `--values-file rows.json` (JSON array) inserts every row in one transaction and **one** journal entry; `revert` deletes them all |
| `update <conn> --table T [--schema s] --set '{json}' --where "..." [--pk Id]` | update (snapshots prior rows) |
| `delete <conn> --table T [--schema s] --where "..." [--pk Id]` | delete (snapshots removed rows) |
| `ddl <conn> "<CREATE/ALTER/DROP ...>" \| --file <a.sql>` | DDL (dev/hml only) `[--yes] [--no-tx]` |
| `exec <conn> "<EXEC proc ... \| batch>" \| --file <a.sql>` | procedure call / arbitrary batch (dev/hml only), **every** result set printed — `[--yes] [--format table\|json] [--timeout s] [--stats] [--top N] [--full]`; see [exec](#running-a-procedure-or-batch-exec) |
| `log [--all]` | list the mutation history |
| `show <id> [--full]` | detail one entry (`--full` shows the snapshot) |
| `revert <id>` | undo one mutation |
| `revert-last` | undo the most recent non-reverted mutation |
| `cache-clear` | clear the `result_cache` |

Mutations require `--yes`; without it they **dry-run** and print the SQL, the
affected count, and the snapshot. `--pk` is required in practice for
`update`/`delete` so the revert can key by primary key.

### Output (token economy)

Read output is compact by default (tuned for LLM context):

- `--format table|tsv|jsonl|json|count` — default `table`; `count` prints just the number.
- **Fully-null columns are hidden** by default; use `--full` to show them.
- `--top N` limits rows (default **50**, max **500**); truncation is reported.
- On `query`/`select`, `--cache [ttl]` stores the result in `result_cache` (TTL
  in seconds, default 300) — handy for reference/enum tables. Reads without
  `--cache` are never cached.
- `--timeout <s>` raises the per-request timeout (default **120 s**) for one call.

### Measuring a query (`query --stats`)

`--stats` runs the query with `SET STATISTICS IO, TIME ON` and prints, on **stderr**
(so `--format json` stays clean), the reads per table and the server time:

```
-- stats: logical reads 174,446, physical 0, read-ahead 6,263 | server CPU 1,406 ms, elapsed 8,541 ms (compile 2,514 ms) | client 13,685 ms
--   [dbo].[OrderLine]: logical 174,423, physical 0, read-ahead 6,263, scans 4
```

**Logical reads** is the number to compare before/after an index: pages touched, the
same whether they were in memory or not. Elapsed time swings with cache and load.
Add `OPTION (RECOMPILE)` to the query so a cached plan from before the index does
not hide it. `--stats` skips `--cache` (a cached answer has no reads).

### Running a procedure or batch (`exec`)

`query` refuses procedure calls (see below); `exec` is where they go — a harness proc,
a batch with its own `BEGIN TRAN ... ROLLBACK`, a script with `GO` separators:

```bash
node index.js exec DEV1 "DECLARE @f bigint = 270; EXEC tenant1.usp_X @FilterId = @f"            # dry-run
node index.js exec DEV1 "DECLARE @f bigint = 270; EXEC tenant1.usp_X @FilterId = @f" --yes --format json --timeout 900
node index.js exec DEV1 --file ./harness.sql --yes --stats
```

- **Non-prod write connections only**, the same rule as `ddl`: prod is refused with **no**
  override, read-only connections too.
- Without `--yes` it is a **dry-run** that prints the batches and connects to nothing.
- The text runs **as written**: no implicit transaction (a batch's own `BEGIN TRAN ... ROLLBACK`
  must not be nested in one of ours), batches split on `GO` lines, all on **one session** and
  sent as raw batches (not through `sp_executesql`) — `#temp` tables, `SET` options and an open
  transaction carry from one `GO` batch to the next. A transaction still open at the end is
  reported and rolled back.
- **Every result set** is printed. `--format table` (default): one block per result set.
  `--format json`: **one** JSON document on stdout and nothing else
  (`{"resultSets":[[{...}],[...]],"rowsAffected":[...]}`, plus `"truncated":[{"resultSet":n,"shown":x,"total":y}]`
  when `--top` cut a result set); the summary line and `PRINT` messages go to stderr.
  `--top`/`--full` apply per result set as in `query`. Note the difference from
  `query --format json`, which prints the first result set's array followed by a `(N row(s))` line.
- `--stats` sums reads and server time over all batches (stderr); `--timeout` as in `query`.
- Journaled as `op=exec` (the full text, batches run, rows affected, the error if any) —
  failed runs too, since an earlier batch may already have changed data. **Not revertible**:
  `revert` refuses it.

## How revert works

| Operation | What is recorded | Revert |
|---|---|---|
| `update` | full snapshot of the affected rows (before) | `UPDATE` restoring the values by PK |
| `delete` | full snapshot of the removed rows | `INSERT` them back (with `IDENTITY_INSERT` if the PK is an identity) |
| `insert` | the inserted PKs (via `OUTPUT INSERTED`) | `DELETE` those PKs |
| `ddl` | the DDL text only (for audit) | **not auto-revertible** — undo manually with another `ddl` |
| `exec` | the batch text, batches run, rows affected, error (for audit) | **not auto-revertible** — dbq does not know what the batch changed |

Each mutation runs in a transaction, so the snapshot and the change are atomic.

## Safety

- Mutations require `--yes`. Without it → **dry-run** (shows SQL, count, snapshot).
- `readonly:true` connections **refuse** any mutation.
- `prod:true` connections **block** mutations unless `--force-prod` (avoid it).
- `query` accepts only reads — see [the read-only guard](#the-query-read-only-guard);
  raw-SQL mutations are refused so the journal is never bypassed.
- `ddl` runs only on **non-prod write** connections (dev/hml). It is **blocked
  in prod** (prod DDL goes through the migrations pipeline) and is **not
  revertible** by the journal — only the text is recorded, for audit. Supports
  `--file <a.sql>` (batches split on `GO`) and `--no-tx` for non-transactional DDL.
- `exec` follows the same rule as `ddl` (non-prod write only, no prod override) and is
  journaled as `op=exec`, not revertible.
- `DBQ_ENV_FILE=<path>` reads connections from another `.env` (the test suite uses it with fake
  connections). Every run announces it on stderr, so a run against an unexpected file shows.

### The `query` read-only guard

`query` runs against production too, so its guard is the whole of "read-only" there. It
used to look only at the start of the text — a `DECLARE` prefix let `EXEC anything`
through, a `WITH` prefix skipped the mutation check, `exec sp_help ...; EXEC other` passed
on its prefix, and `SELECT ... INTO` was never caught.

Now it first blanks out comments (`--`, nested `/* */`), string literals (`'...'` with `''`,
`N'...'`) and delimited identifiers (`[...]`, `"..."`), then checks **every token of the
batch**. Accepted:

- `SELECT ...` / `WITH ... SELECT ...`, optionally after scalar `DECLARE @v type = value`
  and `SET @v = ...` (and `SELECT @v = ...`);
- **one** read-only system procedure as the **whole** batch: `sp_help` and the system
  `sp_help*` family (closed list), `sp_columns`, `sp_helptext`,
  `sp_describe_first_result_set`, `sp_spaceused` (object name only) — unqualified or `sys.`.

Refused anywhere in the batch, with the reason and the command to use instead:
`EXEC`/`EXECUTE` (anything else), `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `DROP`, `TRUNCATE`,
`ALTER`, `CREATE`, `GRANT`, `REVOKE`, `DENY`, `BACKUP`, `RESTORE`, `DBCC`, `KILL`, `SHUTDOWN`,
`BULK`, `OPENROWSET`, `OPENQUERY`, `OPENDATASOURCE`, `sp_executesql`, `xp_*`, `SELECT ... INTO`,
`BEGIN`/`COMMIT`/`ROLLBACK`/`SAVE`, `WAITFOR`, control flow (`IF`, `WHILE`, `GOTO`), cursors,
table variables, `SET <option>`, `USE`, `NEXT VALUE FOR`, and a batch that does not start with
`SELECT`/`WITH`/`DECLARE`/`SET` (a procedure name as the first statement runs without `EXEC`).
An unterminated literal or comment is refused too — the guard fails closed.

The word inside a string, a comment or brackets does not count: `SELECT [Delete] FROM t`
and `SELECT 'drop' AS x` pass. A column named like a keyword must be written `[Bracketed]`.
Procedure calls — including the `DECLARE @f ...; EXEC proc` harness pattern that used to slip
through — go to `exec` on a non-prod connection.

## Multi-tenant / schema

**A schema here is a tenant.** Which one is correct depends on the connection, the
environment and the client, so no global default can be right — and on some databases
the fallback schema does not exist at all (`DEV1` has `tenant1`, `tenant2`, `tenant3`, `tenant8`,
`tenant17`… and no bare `sch`).

Resolution order, in one place (`resolveTarget`):

1. an explicitly qualified table — `--table tenant1.Contract` or `describe <conn> tenant1.Contract`
2. `--schema schN`
3. the connection's own default — `<CONN>_SCHEMA=tenant1` in `.env`, the same sidecar
   shape as the existing `<CONN>_DESC`
4. `DEFAULT_SCHEMA` (`sch`)

Passing both a qualified table and a conflicting `--schema` is an error, not a
silent winner.

> A qualified name used to be mangled rather than understood: `--table tenant1.Contract`
> became `[sch].[tenant1.Contract]` — a single broken identifier — and SQL Server then
> complained about the *table*, which sends you looking in the wrong place.

**Stop guessing `schN`.** `schemas` answers it directly:

```bash
node index.js schemas DEV1                     # every user schema + table count
node index.js schemas DEV1 --table Contract    # which tenants have this table
```

The second form also exposes tenant drift — on `DEV1`, `Contract` has 15 columns in
`tenant1` but 12 in `tenant2` and `tenant3`.

## Examples

```bash
node index.js conns

# reads
node index.js query  HML "SELECT TOP 5 * FROM sch.Widget"
node index.js select HML --table Widget --where "Id = 123" --top 10
node index.js count  HML --table Widget --where "Status = 7"
node index.js describe HML Widget --schema tenant1

# mutations (require --yes; otherwise dry-run)
node index.js update HML --table Widget --pk Id --set '{"Name":"new"}' --where "Id = 123" --yes
node index.js insert HML --table Widget --pk Id --values '{"Name":"x","Status":1}' --yes
node index.js delete HML --table Widget --pk Id --where "Id = 999" --yes

# DDL (dev/hml only; blocked in prod; not revertible)
node index.js ddl DEV "CREATE TABLE tenant1.Foo(Id bigint IDENTITY PRIMARY KEY, Name varchar(50))" --yes
node index.js ddl DEV --file ./migration.sql --yes

# procedure / batch (dev/hml only; blocked in prod; not revertible; every result set)
node index.js exec DEV "EXEC tenant1.usp_Report @Id = 1" --yes --format json

# history / undo
node index.js log
node index.js show 3
node index.js revert 3
node index.js revert-last
```

## License

MIT — see [LICENSE](LICENSE).
