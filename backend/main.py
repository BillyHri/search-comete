"""
search-comete — backend/main.py
FastAPI app. Routes only — query logic lives in search.py.

Run: uvicorn backend.main:app --reload --port 8000
  OR (from backend/ dir): uvicorn main:app --reload --port 8000
"""

from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from elasticsearch import AsyncElasticsearch
from typing import Optional
import os

from .models import SearchResponse, PaperDetail
from . import search as es_search

app = FastAPI(title="search-comete API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve pre-built stars.json as a static file (fast initial galaxy load)
_stars_path = os.path.join(os.path.dirname(__file__), '..', 'pipeline', 'stars.json')
if os.path.exists(_stars_path):
    app.mount("/static", StaticFiles(directory=os.path.dirname(_stars_path)), name="static")

# ── Elasticsearch client ──────────────────────────────────────────────────────
ES_HOST      = os.getenv("ES_HOST",      "http://localhost:9200")
ES_CLOUD_ID  = os.getenv("ES_CLOUD_ID",  "")
ES_API_KEY   = os.getenv("ES_API_KEY",   "")

def _make_es_client() -> AsyncElasticsearch:
    if ES_CLOUD_ID and ES_API_KEY:
        return AsyncElasticsearch(cloud_id=ES_CLOUD_ID, api_key=ES_API_KEY)
    return AsyncElasticsearch(ES_HOST)

es = _make_es_client()

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    try:
        info = await es.info()
        return {"status": "ok", "es_version": info["version"]["number"]}
    except Exception as e:
        return {"status": "degraded", "error": str(e)}


@app.get("/search", response_model=SearchResponse)
async def search(
    q:       str           = Query(..., description="Search query"),
    size:    int           = Query(20, ge=1, le=100),
    cluster: Optional[str] = Query(None, description="Filter by cluster ID"),
):
    try:
        total, results = await es_search.text_search(es, q, size=size, cluster=cluster)
        return SearchResponse(total=total, results=results, query=q)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/stars")
async def stars(cluster: Optional[str] = Query(None)):
    """All star positions for the galaxy. Frontend calls this once on load."""
    try:
        data = await es_search.get_all_stars(es, cluster=cluster)
        return {"count": len(data), "stars": [s.dict() for s in data]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/paper/{paper_id}", response_model=PaperDetail)
async def paper(paper_id: str):
    """Full paper detail + kNN similar papers."""
    result = await es_search.get_paper_with_similar(es, paper_id)
    if not result:
        raise HTTPException(status_code=404, detail="Paper not found")
    return result


@app.get("/stats")
async def stats():
    """Cluster breakdown for the legend."""
    try:
        return await es_search.get_cluster_stats(es)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
