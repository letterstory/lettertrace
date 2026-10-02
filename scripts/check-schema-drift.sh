#!/usr/bin/env bash
#
# Detects drift between supabase/schema.sql and what's actually applied in
# prod -- the failure class behind INC-426 (2026-09-21/22, PR #202/#203).
# #202 shipped app code that wrote to columns and a table schema.sql
# declared, but nobody ran schema.sql against prod before the code deployed.
# There was no CI signal: schema.sql is a single hand-maintained file (no
# supabase/migrations/ directory, no Supabase-CLI migration ledger), so
# letterstory/letterstory's migration-order / schema-drift checks (which
# read supabase_migrations.schema_migrations) don't apply here -- there is
# no ledger to read. This script checks the one thing that actually broke:
# does every table/column schema.sql declares actually exist in prod?
#
# Scope is deliberately narrow: CREATE TABLE and ALTER TABLE ... ADD COLUMN
# are the two statement shapes that caused the outage (a missing table, and
# columns missing from an existing table). Constraints/indexes/triggers/
# policies don't cause the "column does not exist" class of failure and
# aren't checked here.
#
# Usage: scripts/check-schema-drift.sh [--ref <project-ref>]
# Reads the PAT from $SUPABASE_ACCESS_TOKEN, falling back to
# ~/.supabase/access-token. Exit 0 = clean, 1 = drift found, 2 = bad args,
# 3 = API/setup error.

set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-fimiewdxsgsxspvgunoh}" # lettertrace prod
SCHEMA_FILE="supabase/schema.sql"

usage() {
    echo "Usage: $0 [--ref <project-ref>]"
    echo "  --ref   Supabase project ref to check (default: \$SUPABASE_PROJECT_REF or lettertrace prod)"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --ref)
            PROJECT_REF="${2:-}"
            [ -n "$PROJECT_REF" ] || { echo "::error::--ref requires a value" >&2; exit 2; }
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "::error::Unknown argument: $1" >&2
            usage
            exit 2
            ;;
    esac
done

if [ ! -f "$SCHEMA_FILE" ]; then
    echo "::error::$SCHEMA_FILE not found." >&2
    exit 3
fi

if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
    PAT="$SUPABASE_ACCESS_TOKEN"
elif [ -f "$HOME/.supabase/access-token" ]; then
    PAT="$(cat "$HOME/.supabase/access-token")"
else
    echo "::error::No Supabase PAT found. Set \$SUPABASE_ACCESS_TOKEN or create ~/.supabase/access-token." >&2
    exit 3
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "::error::jq is required." >&2
    exit 3
fi

# --- extract declared tables and columns from schema.sql ---
# Join each statement onto one line (records split on ';') so a
# multi-line "alter table ... \n add column ..." matches a single regex.
statements="$(awk 'BEGIN{RS=";"} {gsub(/\n/," "); print}' "$SCHEMA_FILE")"

declared_tables="$(printf '%s\n' "$statements" \
    | grep -ioE 'create table( if not exists)? public\.[a-z_][a-z0-9_]*' \
    | awk '{print $NF}' | sed 's/^public\.//' | sort -u)"

declared_columns="$(printf '%s\n' "$statements" \
    | grep -ioE 'alter table public\.[a-z_][a-z0-9_]* +add column( if not exists)? [a-z_][a-z0-9_]*' \
    | sed -E 's/^alter table public\.([a-z0-9_]+) +add column( if not exists)? ([a-z0-9_]+)$/\1 \3/I' \
    | sort -u)"

if [ -z "$declared_tables" ] && [ -z "$declared_columns" ]; then
    echo "::error::Parsed zero CREATE TABLE / ADD COLUMN statements from $SCHEMA_FILE -- extraction regex likely broken, refusing to report a false-clean result." >&2
    exit 3
fi

# --- build one SQL query covering every declared table + column ---
tables_values="$(printf '%s\n' "$declared_tables" | awk 'NF{printf "(%s),", "\x27"$0"\x27"}' | sed 's/,$//')"
columns_values="$(printf '%s\n' "$declared_columns" | awk 'NF{split($0,a," "); printf "(%s,%s),", "\x27"a[1]"\x27", "\x27"a[2]"\x27"}' | sed 's/,$//')"

[ -n "$tables_values" ] || tables_values="('__none__')"
[ -n "$columns_values" ] || columns_values="('__none__','__none__')"

sql="with declared_tables(name) as (values ${tables_values}),
declared_columns(tbl, col) as (values ${columns_values})
select 'table' as kind, name as tbl, null as col from declared_tables dt
  where dt.name <> '__none__'
    and not exists (select 1 from information_schema.tables t where t.table_schema='public' and t.table_name=dt.name)
union all
select 'column', tbl, col from declared_columns dc
  where dc.tbl <> '__none__'
    and not exists (select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=dc.tbl and c.column_name=dc.col)
    and exists (select 1 from information_schema.tables t where t.table_schema='public' and t.table_name=dc.tbl);"

query() {
    local sql="$1"
    local payload
    payload="$(jq -n --arg q "$sql" '{query: $q}')"
    local resp http_code body attempt max_attempts delay
    max_attempts=4
    delay=5
    attempt=1
    while :; do
        resp="$(curl -sS -w '\n%{http_code}' \
            -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
            -H "Authorization: Bearer ${PAT}" \
            -H "Content-Type: application/json" \
            -d "$payload")"
        http_code="$(printf '%s\n' "$resp" | tail -1)"
        body="$(printf '%s\n' "$resp" | sed '$d')"
        if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
            printf '%s\n' "$body"
            return 0
        fi
        case "$http_code" in
            5*|"") ;;
            *)
                echo "::error::Management API query failed (HTTP $http_code): $body" >&2
                exit 3
                ;;
        esac
        if [ "$attempt" -ge "$max_attempts" ]; then
            echo "::error::Management API query failed (HTTP $http_code) after $max_attempts attempts: $body" >&2
            exit 3
        fi
        echo "::warning::Management API query failed (HTTP $http_code), attempt $attempt/$max_attempts -- retrying in ${delay}s: $body" >&2
        sleep "$delay"
        delay=$((delay * 3))
        attempt=$((attempt + 1))
    done
}

result_json="$(query "$sql")"
missing_count="$(printf '%s\n' "$result_json" | jq 'length')"

if [ "$missing_count" -gt 0 ]; then
    echo "::error::supabase/schema.sql declares objects that don't exist in prod (project $PROJECT_REF):"
    printf '%s\n' "$result_json" | jq -r '.[] | if .kind == "table" then "  MISSING TABLE  public." + .tbl else "  MISSING COLUMN public." + .tbl + "." + .col end'
    echo ""
    echo "This is exactly the gap that caused INC-426: code depending on a schema.sql"
    echo "change was deployed before the schema change reached prod. Apply the missing"
    echo "objects to prod (Supabase SQL editor or 'supabase db push' equivalent) before"
    echo "merging, or before this check runs again on push to master."
    exit 1
fi

echo "No schema drift against project $PROJECT_REF -- every table/column in $SCHEMA_FILE exists in prod."
