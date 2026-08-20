# SQL DDL — `sql-ddl`

Fixtures for **FMT-5.6** ([#5444](https://github.com/apiome/apiome/issues/5444)) — the import twin of
the filed DDL **emitter** (**#4311**). For most organizations the database is the only formal schema
that exists, which makes reverse-engineering it the single broadest on-ramp into a catalog. Entries
carry `adapter_key: null` and the `pending-adapter` tag.

**Detection marker.** `CREATE TABLE` / `CREATE VIEW` / `CREATE TYPE` / `ALTER TABLE … ADD CONSTRAINT`
statements. Dialect is a *second* decision after that, and every fixture below is labelled with the
dialect it must be detected as.

| File | Rung | Dialect | What it exercises |
| --- | --- | --- | --- |
| `01-minimal-ansi.sql` | minimal | ANSI | One table, one composite-free primary key. |
| `02-typical-postgres.sql` | typical | PostgreSQL | `CREATE TYPE … AS ENUM`, quoted identifiers, `timestamptz`, `numeric(p,s)`, named checks, FK actions, expression index, `COMMENT ON`, a view. |
| `03-migrations-set/` | multi-file | PostgreSQL | Three ordered migrations — rename, widen, constrain. The import must take the **final** state, not the first. |
| `04-stress-mysql.sql` | stress | MySQL | `AUTO_INCREMENT`, backtick quoting, `ENUM`/`SET`, `JSON`, `STORED`/`VIRTUAL` generated columns, `FULLTEXT`, `ENGINE`/charset, `RANGE` partitions, multi-clause `ALTER TABLE`. |
| `05-real-world-sqlserver.sql` | real-world | SQL Server | Schemas + `GO` batches, `IDENTITY`, `NVARCHAR(MAX)`, `ROWVERSION`, `PERSISTED` computed column, filtered index with `INCLUDE`, a view. |
| `06-typical-oracle.sql` | typical | Oracle | `VARCHAR2`/`NUMBER`/`CLOB`/`BLOB`, identity column, sequence, out-of-line named constraints, range partitions, `COMMENT ON`. |
| `07-composition-inheritance-and-views.sql` | composition | A domain and composite type reused across tables, table inheritance, partitioning, and a view over three tables. |
| `negative/` | — | — | Missing parenthesis, a table with no columns, truncation, a DBML file, UTF-16, and a foreign key to a table that does not exist. |

**Scope boundary.** FMT-5.6 is **file intake only** — live introspection against a connection string
is explicitly out of scope, which keeps the security surface small. Vendor constructs that cannot be
modelled (partitions, storage clauses, `ROWVERSION`) must be declared parsing limits, and the dialect
must be recorded in provenance with an override available.
