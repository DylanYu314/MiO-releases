"""Manage access keys from the command line (ADR-009).

Usage (from backend/, with the app's environment):
    python -m scripts.access_keys create --label "a phone"
    python -m scripts.access_keys list
    python -m scripts.access_keys revoke <id>

`create` prints the token once — it is stored only as a hash and can never be
shown again. Keys gate the import entrypoints; the gate stays off until the
first key exists.

There is deliberately no `claim`/`release` here any more. They existed to work
around the key deciding which library you saw, and #170 removed that: a key now
gates search and import, and ownership belongs to an install. Rows owned by
nobody are seen by nobody, which is the intended end state rather than a gap to
patch.
"""

import argparse
import sys
from datetime import UTC, datetime

from sqlalchemy import select

from app.access_keys import create_access_key
from app.db import SessionLocal
from app.models import AccessKey


def _create(label: str, is_admin: bool = False) -> None:
    db = SessionLocal()
    try:
        row, token = create_access_key(db, label, is_admin=is_admin)
        kind = "ADMIN access key" if is_admin else "access key"
        print(f"Created {kind} #{row.id} ({row.label}).")
        if is_admin:
            # Said at creation, because this is the one key whose blast radius
            # is other people's data rather than the holder's own.
            print("This key can read every user's diagnostics. Do not hand it to a tester.")
        print(f"\n  {token}\n")
        print("Store it now — it can't be shown again.")
    finally:
        db.close()


def _list() -> None:
    db = SessionLocal()
    try:
        rows = db.scalars(select(AccessKey).order_by(AccessKey.id)).all()
        if not rows:
            print("No access keys. The import gate is off until you create one.")
            return
        for row in rows:
            state = f"revoked {row.revoked_at:%Y-%m-%d}" if row.revoked_at else "active"
            used = f"last used {row.last_used_at:%Y-%m-%d}" if row.last_used_at else "never used"
            # Which keys are admin has to be visible here: it is the only way
            # to notice one was handed out by mistake.
            kind = "ADMIN" if row.is_admin else ""
            print(f"#{row.id:<4} {row.label:<30} {state:<20} {used:<20} {kind}")
    finally:
        db.close()


def _revoke(key_id: int) -> None:
    db = SessionLocal()
    try:
        row = db.get(AccessKey, key_id)
        if row is None:
            sys.exit(f"No access key #{key_id}.")
        if row.revoked_at is not None:
            print(f"Access key #{key_id} was already revoked.")
            return
        row.revoked_at = datetime.now(UTC)
        db.commit()
        print(f"Revoked access key #{key_id} ({row.label}).")
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage MiO access keys.")
    sub = parser.add_subparsers(dest="command", required=True)

    create = sub.add_parser("create", help="mint a new key and print it once")
    create.add_argument("--label", required=True, help="who the key is for")
    create.add_argument(
        "--admin",
        action="store_true",
        help="also allow reading everyone's diagnostics (#354) — for you, not for testers",
    )

    sub.add_parser("list", help="list all keys")

    revoke = sub.add_parser("revoke", help="revoke a key by id")
    revoke.add_argument("id", type=int)

    args = parser.parse_args()
    if args.command == "create":
        _create(args.label, is_admin=args.admin)
    elif args.command == "list":
        _list()
    elif args.command == "revoke":
        _revoke(args.id)


if __name__ == "__main__":
    main()
