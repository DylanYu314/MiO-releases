from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from app.access_keys import require_unlock_key
from app.schemas import SearchResultRead
from app.ytdlp import ExtractionError, SearchResult, TransientExtractionError, search

router = APIRouter(prefix="/search", tags=["search"])

# A search bar shows a page of results, not a playlist's worth.
DEFAULT_LIMIT = 10


@router.get("", response_model=list[SearchResultRead])
def search_sources(
    q: str = Query(min_length=1, description="What to search for"),
    platform: Literal["youtube", "bilibili"] = "youtube",
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=25),
    _: None = Depends(require_unlock_key),
) -> list[SearchResult]:
    """Search a source for videos to import, without downloading anything.

    Results feed the existing POST /jobs — this endpoint adds no new download
    machinery. Runs synchronously (in a threadpool): it's a quick metadata read
    the caller needs an answer to now, not a background job.
    """
    try:
        return search(q, limit=limit, platform=platform)
    except TransientExtractionError as exc:
        # Bilibili answers 412 to anything it reads as crawling, and does so
        # often enough that a raw extractor message would be the common case
        # rather than the exception. 503 says "ask again shortly", which is
        # both true and something the client can act on.
        raise HTTPException(
            status_code=503,
            detail="The source is rate-limiting requests. Try again in a moment.",
        ) from exc
    except ExtractionError as exc:
        # The upstream extractor failed — a gateway problem, not a bad request.
        raise HTTPException(status_code=502, detail=str(exc)) from exc
