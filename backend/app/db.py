from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings

settings = get_settings()

# `timeout` is SQLite's busy timeout: wait this long for another writer to
# finish instead of failing immediately with "database is locked". It matters
# now that the API and the Celery worker are separate processes writing to the
# same file (ADR-006); Postgres removes the constraint in Phase 6.
connect_args = (
    {"check_same_thread": False, "timeout": 30.0}
    if settings.database_url.startswith("sqlite")
    else {}
)
engine = create_engine(settings.database_url, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
