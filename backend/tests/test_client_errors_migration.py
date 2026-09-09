"""The client-errors migration, run the way a migration actually runs.

The reason this file exists is the same as `test_loudness_migration.py`'s:
autogenerate proposed re-typing `playlists.kind` alongside this table, and
**SQLite cannot execute that statement**. The image runs `alembic upgrade head`
on boot, so a migration that fails is an app that does not start — and no test
that goes through the ORM would ever notice, because the ORM creates the schema
from the models rather than by migrating.
"""

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

BACKEND_ROOT = Path(__file__).resolve().parents[1]

# Raw, because the point of these tests is the schema rather than the model.
# `created_at` is spelled out: its default lives in Python, not in the table, so
# an insert that does not go through the ORM has to supply it.
_INSERT = (
    "INSERT INTO client_errors (platform, message, client_key, created_at) "
    "VALUES ('web', :message, :client_key, '2026-08-06 00:00:00')"
)


@pytest.fixture
def migrated_db(tmp_path):
    """A database built by running the real migrations, start to finish."""
    db_path = tmp_path / "client_errors_migration.db"
    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    # Through config.attributes, which is alembic's channel for a programmatic
    # caller — and which env.py uses to skip fileConfig, so this does not
    # reconfigure logging for every test that runs afterwards.
    url = f"sqlite:///{db_path}"
    config.attributes["sqlalchemy.url"] = url
    return config, url


def test_the_whole_chain_runs_on_sqlite(migrated_db):
    """The assertion is that this does not raise.

    An `alter_column` retyping `playlists.kind` would fail here, which is the
    entire point: it is what boot does, and boot is where it would have been
    discovered otherwise.
    """
    config, url = migrated_db
    command.upgrade(config, "head")

    tables = set(inspect(create_engine(url)).get_table_names())
    assert "client_errors" in tables
    # Still present and untouched by the upgrade.
    assert {"songs", "playlists", "installs"} <= tables


def test_client_errors_has_the_columns_the_model_expects(migrated_db):
    config, url = migrated_db
    command.upgrade(config, "head")

    columns = {c["name"] for c in inspect(create_engine(url)).get_columns("client_errors")}

    assert columns == {
        "id",
        "platform",
        "message",
        "stack",
        "description",
        "app_version",
        "os_version",
        "device",
        "owner_install_id",
        "created_at",
        # #322 — the table also holds the device's rolling log now.
        "level",
        "client_key",
    }


def test_owner_install_id_is_not_a_foreign_key(migrated_db):
    """A crash report outlives the install that produced it.

    Autogenerate wanted foreign keys on every `owner_install_id`. On this table
    that would mean losing crash history when an install is forgotten, which is
    the wrong way round — the report is most useful precisely when something has
    gone badly wrong with the client.
    """
    config, url = migrated_db
    command.upgrade(config, "head")

    keys = inspect(create_engine(url)).get_foreign_keys("client_errors")

    assert keys == []


def test_the_level_column_defaults_old_rows_to_error(migrated_db):
    """Written the way a migration writes: raw SQL against the migrated schema.

    The ORM would supply the default itself and prove nothing. What matters is
    the *server* default — it is what lets SQLite add a NOT NULL column to a
    table that already has rows, and it is why every crash stored before #322
    still reads as the error it was rather than as an empty string.
    """
    config, url = migrated_db
    command.upgrade(config, "head")
    engine = create_engine(url)

    with engine.begin() as conn:
        conn.execute(text(_INSERT), {"message": "boom", "client_key": None})
        level = conn.execute(text("SELECT level FROM client_errors")).scalar_one()

    assert level == "error"


def test_client_key_is_unique_but_lets_nulls_repeat(migrated_db):
    """Both halves matter, and they pull in opposite directions.

    UNIQUE is what makes a re-sent batch safe. NULLs repeating is what lets the
    crash path — which mints no key, from a client that may be seconds from
    being killed — keep writing rows at all.
    """
    config, url = migrated_db
    command.upgrade(config, "head")
    engine = create_engine(url)

    with engine.begin() as conn:
        for _ in range(2):
            conn.execute(text(_INSERT), {"message": "boom", "client_key": None})
        conn.execute(text(_INSERT), {"message": "a", "client_key": "k1"})

    # Two keyless rows coexisted; the repeated key does not.
    with pytest.raises(IntegrityError):
        with engine.begin() as conn:
            conn.execute(text(_INSERT), {"message": "b", "client_key": "k1"})

    with engine.begin() as conn:
        assert conn.execute(text("SELECT count(*) FROM client_errors")).scalar_one() == 3


def test_downgrade_removes_only_this_iterations_columns(migrated_db):
    """Targets the revision by id rather than by `-1`.

    `-1` meant "the client-errors columns" only while that was head. It stopped
    being head the moment #354 added another, and the test silently started
    asserting something else — so it names what it means.
    """
    config, url = migrated_db
    command.upgrade(config, "head")
    command.downgrade(config, "d1f145b13692")

    inspector = inspect(create_engine(url))
    columns = {c["name"] for c in inspector.get_columns("client_errors")}
    # The table itself predates this revision and stays.
    assert "client_errors" in set(inspector.get_table_names())
    assert {"level", "client_key"} & columns == set()
    assert {"platform", "message", "created_at"} <= columns


def test_access_keys_gains_is_admin_defaulting_to_not_admin(migrated_db):
    """Written as a migration writes: raw SQL, no ORM default in the way.

    The server default is the safety property. Every key that existed before
    this column was handed to a tester, and none of them should become an
    administrator by being old — an ORM-side default would prove nothing about
    the rows already in the table.
    """
    config, url = migrated_db
    command.upgrade(config, "head")
    engine = create_engine(url)

    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO access_keys (key_hash, label, created_at) "
                "VALUES ('abc', 'a tester', '2026-08-06 00:00:00')"
            )
        )
        is_admin = conn.execute(text("SELECT is_admin FROM access_keys")).scalar_one()

    assert not is_admin
