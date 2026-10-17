#!/usr/bin/env python3
"""Export CKXchange SQLite business data to JSON for a one-time MongoDB import.

The export contains password hashes and encrypted bank-account values; keep it private.
Sessions are intentionally not exported so everyone signs in again after migration.
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

TABLES = ("users", "banks", "transactions", "ledger", "audit_log", "app_settings")


def rows_for(connection, table):
    exists = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    if not exists:
        return []
    connection.row_factory = sqlite3.Row
    return [dict(row) for row in connection.execute(f'SELECT * FROM "{table}"').fetchall()]


def convert(table, rows):
    output = []
    for row in rows:
        if table in ("users", "banks", "transactions"):
            row["_id"] = str(row.pop("id"))
        elif table == "ledger":
            legacy_id = row.pop("id")
            row["_id"] = f"LED-MIG-{legacy_id}"
        elif table == "audit_log":
            legacy_id = row.pop("id")
            details = row.pop("details_json", "{}")
            try:
                row["details"] = json.loads(details or "{}")
            except (TypeError, json.JSONDecodeError):
                row["details"] = {"legacyDetails": str(details)}
            row["_id"] = f"AUD-MIG-{legacy_id}"
        elif table == "app_settings":
            row["_id"] = str(row.pop("setting_key"))
        output.append(row)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="data/ckxchange.sqlite", help="Existing SQLite database path")
    parser.add_argument("--output", default="data/sqlite-export.json", help="Private JSON export path")
    args = parser.parse_args()
    source = Path(args.input).expanduser().resolve()
    destination = Path(args.output).expanduser().resolve()
    if not source.is_file():
        print(f"SQLite database not found: {source}", file=sys.stderr)
        return 1
    if source == destination:
        print("Input and output paths must be different.", file=sys.stderr)
        return 1
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.umask(0o077)
    try:
        with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as connection:
            payload = {
                "format": "ckxchange-sqlite-export-v1",
                "exportedAt": datetime.now(timezone.utc).isoformat(),
                "collections": {table: convert(table, rows_for(connection, table)) for table in TABLES},
                "sessionsImported": False,
            }
        with open(destination, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        os.chmod(destination, 0o600)
        summary = {name: len(rows) for name, rows in payload["collections"].items()}
        print(f"Export complete: {destination}")
        print("Records:", ", ".join(f"{name}={count}" for name, count in summary.items()))
        print("WARNING: this file contains sensitive account records. Do not upload it or commit it to Git.")
        print("The original SQLite database was not changed or deleted.")
        return 0
    except sqlite3.Error as error:
        print(f"Could not read SQLite database: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
