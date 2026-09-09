from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app import models  # noqa: F401  (registers models on Base.metadata)
from app.config import get_settings
from app.db import Base

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Interpret the config file for Python logging.
#
# Skipped when a caller hands in an explicit URL, i.e. when the tests drive
# alembic in-process. `fileConfig` reconfigures logging **globally**: it replaces
# root handlers and, by default, disables every logger that already exists. Run
# inside pytest that silently breaks `caplog` for every test that comes
# afterwards — which is how a migration test renamed from
# `test_owner_key_migration` to `test_install_migration` moved alphabetically
# ahead of `test_logging` and made two unrelated tests fail with no visible
# connection between them.
#
# `alembic upgrade head` on container start still gets its logging configured,
# which is the case this line exists for.
if config.config_file_name is not None and "sqlalchemy.url" not in config.attributes:
    fileConfig(config.config_file_name)

# A programmatic caller can hand in an explicit URL through `config.attributes`
# (alembic's documented channel for exactly this); otherwise the app's own
# settings decide, which is what happens for `alembic upgrade head` on start.
# The tests use the override to run real migrations against a throwaway
# database — this project has twice shipped migration bugs that neither test
# layer could see, because nothing ever exercised the migrations themselves.
_url_override = config.attributes.get("sqlalchemy.url")
config.set_main_option("sqlalchemy.url", _url_override or get_settings().database_url)

target_metadata = Base.metadata

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
