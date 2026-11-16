# Anastasy — reversible SQL Server CLI (`dbq`)

Runs `SELECT / INSERT / UPDATE / DELETE` against SQL Server in a structured way
and keeps a **git-like undo journal**: every mutation records the prior state
(or the inserted PKs) so it can be **reverted**. Also runs **DDL**
(`CREATE / ALTER / DROP`), restricted to non-prod write connections — DDL is
audited in the journal but is **not** auto-revertible (see [Safety](#safety)).

```
node index.js <command>
```

**Storage:** a local SQLite file (`dbq.sqlite`, via the built-in `node:sqlite`)
with three tables — `journal` (a gzipped row snapshot per mutation),
`schema_cache` (columns / types / PK / identity per table), and `result_cache`
(opt-in cached reads with a TTL).

**Local files, never committed** (all in `.gitignore`): `.env` (connections), `dbq.sqlite` (the journal holds
real row snapshots, so treat it as the data it came from), and `recipes/`, a free folder for your own SQL and
notes about your databases. Keep them in this folder: the tool reads them from here on every run.

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
| `query <conn> "<SELECT ...>" | --file <a.sql>` | read-only SQL (`SELECT`/`WITH`) — `--cache [ttl]` to memoize; `--stats` for reads and server time. `--file` sends a long query (a `VALUES` list, a CTE chain) exactly as written; inline and `--file` together are refused |
| `select <conn> --table T [--schema s] [--where "..."] [--top N] [--columns "a,b"]` | structured SELECT |
| `count <conn> <table> | --table T [--where "..."]` | just the count (cheap in tokens); the table can be positional, like `describe` |
| `describe <conn> <table> [--schema s] [--refresh]` | columns/types (uses `schema_cache`) |
| `auth <conn> [--password <p>] [--ttl <min>] [--clear] [--device]` | cache a session password, or sign in with Azure AD (browser / device code) |
| `insert <conn> --table T [--schema s] --values '{json}' [--pk Id]` | insert (records inserted PKs). `--values '[{..},{..}]'` or `--values-file rows.json` (JSON array) inserts every row in one transaction and **one** journal entry; `revert` deletes them all |
| `update <conn> --table T [--schema s] --set '{json}' --where "..." [--pk Id]` | update (snapshots prior rows) |
| `delete <conn> --table T [--schema s] --where "..." [--pk Id]` | delete (snapshots removed rows) |
| `ddl <conn> "<CREATE/ALTER/DROP ...>" \| --file <a.sql>` | DDL (dev/hml only) `[--yes] [--no-tx]` |
| `log [--all]` | list the mutation history |
| `show <id> [--full]` | detail one entry (`--full` shows the snapshot) |
| `revert <id>` | undo one mutation |
| `revert-last` | undo the most recent non-reverted mutation |
| `cache-clear` | clear the `result_cache` |

Mutations require `--yes`; without it they **dry-run** and print the SQL, the
affected count, and the snapshot. `--pk` is required in practice for
`update`/`delete` so the revert can key by primary key.

`dbq --help`, `dbq <command> --help`, `-h` and `dbq help` print the usage and exit 0
without running anything. An unknown flag is still refused (exit 1); for flags borrowed
from other CLIs the refusal names the real spelling (`--json` → `--format json`,
`--limit` → `--top N`, `--conn` → the connection is the first positional).
`--no-strict-flags` turns the refusal into a warning, for unattended pipelines only: a dropped `--yes`
turns a mutation into a dry-run and a dropped `--where` removes a `DELETE`'s filter, so never use it to get
past a typo.

> ⚠️ **`insert` prints two numbers:** `OK insert: PK(s) 369. journal #248. revert: …`. A script that loads
> parent/child rows must read the parent id with an anchored regex (`PK\(s\)\s+(\d+)`); a loose `\d+` picks the
> journal number and the children land under the wrong parent with no error. After such a load, check children
> per parent, orphans and FKs, and keep the journal range (revert newest to oldest).

### Helper scripts (`scripts/`)

Read-only helpers built on `dbq`, for questions a single query does not answer:

| Script | What |
|---|---|
| `pending-migrations.js` | FluentMigrator: `[Migration(n)]` classes at a git ref × the versions recorded in the version table — pending public migrations in the order `MigrateUp` applies them, non-public classes that never run, real duplicate versions vs. the same file committed under paths that differ only in case, and versions recorded by another runner. Reads code with `git ls-tree` + one `git cat-file --batch` (no checkout). |

```bash
node scripts/pending-migrations.js --conn <CONN> --repo <path-to-clone> \
  [--ref origin/main] [--path src/Migrations] [--schema <s>] [--table VersionInfo] [--json]
```

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

### Measuring a procedure (`exec`)

`query` does not run `EXEC`. To read what a procedure returns, or to measure it, use `exec`:

```bash
dbq exec DEV "EXEC tenant1.usp_Report @Id = 1, @From = '2026-01-01'" --stats --format count
dbq exec DEV "EXEC tenant1.usp_Report @Id = 1" --format json            # ONE document: {"resultSets":[[...]],"rowsAffected":[...]}
dbq exec DEV "EXEC tenant1.usp_Report @Id = 1" --out ./report.json      # every row of every set, no --top cap
```

- One procedure call per run: no second statement, no dynamic SQL (`sp_executesql`, `EXEC('...')`),
  no mutation keyword outside the call.
- It runs inside a transaction that is **always rolled back**, so a procedure that writes to
  `#temp` tables (or to real ones, by accident) leaves nothing behind. Every result set is printed.
- If the procedure ends the transaction itself (`COMMIT`/`ROLLBACK` inside it), dbq cannot roll back
  and the command **fails**, saying its writes are permanent.
- Refused on PROD connections with write rights (no override). A read-only connection (reader user)
  is allowed; the server refuses writes there anyway.
- Before running a procedure that can loop (a `WHILE` over input), check the input: the rollback undoes
  writes, not the CPU a loop burns on a shared database until `--timeout`.
- `--format json` prints one document for all result sets (each capped by `--top`; a cut set is listed in
  `truncated`). `--out <file>` writes that document with every row and column to the file and prints only
  the counts: use it when a comparison needs the whole result and the transcript only the totals.

Per-statement cost of a procedure, after running it: `sys.dm_exec_query_stats` × `sys.dm_exec_sql_text`
filtered by `objectid = OBJECT_ID('<schema>.<proc>')`, ordered by `last_logical_reads`.

## How revert works

| Operation | What is recorded | Revert |
|---|---|---|
| `update` | full snapshot of the affected rows (before) | `UPDATE` restoring the values by PK |
| `delete` | full snapshot of the removed rows | `INSERT` them back (with `IDENTITY_INSERT` if the PK is an identity) |
| `insert` | the inserted PKs (via `OUTPUT INSERTED`) | `DELETE` those PKs |
| `ddl` | the DDL text only (for audit) | **not auto-revertible** — undo manually with another `ddl` |

Each mutation runs in a transaction, so the snapshot and the change are atomic.

**Known limitation: composite primary keys.** The journal key is a single column (`--pk`, default `Id`). On a
table whose primary key has two or more columns (a link table such as user × unit), `insert` records only the
column passed in `--pk`, and `revert` deletes **every row** that shares that value, not just the one inserted.
Seen 2026-11-05. Until composite keys are supported: on such tables, `show <id>` before any `revert`, and undo
an insert with a `delete` whose `--where` names every key column.

## Safety

- Mutations require `--yes`. Without it → **dry-run** (shows SQL, count, snapshot).
- `readonly:true` connections **refuse** any mutation.
- `prod:true` connections **block** mutations unless `--force-prod` (avoid it).
- `query` accepts only `SELECT` / `WITH ... SELECT`, optionally after scalar `DECLARE @v` / `SET @v`, or
  one system `sp_help*` / `sp_columns` / `sp_helptext` / `sp_describe_first_result_set` / `sp_spaceused`
  as the whole batch (a closed list: a user procedure named `sp_help_x` does not pass). It blanks out
  comments, string literals and `[bracketed]`/`"quoted"` identifiers, then checks **every token of the
  batch** and lists every problem it finds: `EXEC`, DML, `MERGE`, `SELECT ... INTO`, DDL, permissions,
  `BACKUP`/`DBCC`/`KILL`, `OPENROWSET`/`OPENQUERY`, `sp_executesql`, `xp_*`, transactions, `WAITFOR`,
  control flow, cursors, table variables, session `SET` options. A literal or comment that does not close
  is refused (fails closed).
- `exec` runs one procedure call and always rolls back (see *Measuring a procedure*).
- `ddl` runs only on **non-prod write** connections (dev/hml). It is **blocked
  in prod** (prod DDL goes through the migrations pipeline) and is **not
  revertible** by the journal — only the text is recorded, for audit. Supports
  `--file <a.sql>` (batches split on `GO`) and `--no-tx` for non-transactional DDL.

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

# history / undo
node index.js log
node index.js show 3
node index.js revert 3
node index.js revert-last
```

## Tests

`npm test` (`node --test`) — 147 tests in `test/`, no database or network (the CLI cases run against fake connections via `DBQ_ENV_FILE` and stop before connecting). `main()` runs only behind
`require.main === module`, so the module imports cleanly into the tests.

## License

MIT — see [LICENSE](LICENSE).
