"""
search-comete — search.py
All Elasticsearch query logic, isolated from the FastAPI routes.
"""

from elasticsearch import AsyncElasticsearch
from .models import SearchResult, StarPoint, SimilarPaper, PaperDetail

INDEX = "knowledge_galaxy"


async def text_search(
    es: AsyncElasticsearch,
    query: str,
    size: int = 20,
    cluster: str | None = None,
) -> tuple[int, list[SearchResult]]:
    """
    Hybrid BM25 + field-boosted search.
    Returns (total_hits, results).
    """
    filters = []
    if cluster:
        filters.append({"term": {"cluster_id": cluster}})

    body = {
        "query": {
            "bool": {
                "should": [
                    {"match": {"title":    {"query": query, "boost": 2.5}}},
                    {"match": {"abstract": {"query": query, "boost": 1.0}}},
                ],
                "filter": filters,
                "minimum_should_match": 1,
            }
        },
        "size": size,
        "_source": {"excludes": ["embedding"]},
    }

    resp = await es.search(index=INDEX, body=body)
    max_score = resp["hits"]["max_score"] or 1.0
    results   = [
        SearchResult(
            id       = h["_source"]["id"],
            title    = h["_source"]["title"],
            authors  = h["_source"].get("authors", ""),
            year     = h["_source"].get("year"),
            cite     = h["_source"].get("citations", 0),
            abstract = h["_source"].get("abstract", ""),
            cluster  = h["_source"]["cluster_id"],
            color    = h["_source"].get("cluster_color", "#ffffff"),
            x        = h["_source"]["pos_x"],
            y        = h["_source"]["pos_y"],
            z        = h["_source"]["pos_z"],
            score    = round(h["_score"] / max_score, 3),
        )
        for h in resp["hits"]["hits"]
    ]
    return resp["hits"]["total"]["value"], results


async def get_all_stars(
    es: AsyncElasticsearch,
    cluster: str | None = None,
) -> list[StarPoint]:
    """
    Returns every paper's lightweight star data for the galaxy render.
    For 10k+ papers serve stars.json as a static file instead.
    """
    query = {"term": {"cluster_id": cluster}} if cluster else {"match_all": {}}
    resp  = await es.search(
        index=INDEX,
        body={
            "query": query,
            "size":  10000,
            "_source": ["id","title","authors","year","citations",
                        "cluster_id","cluster_color","pos_x","pos_y","pos_z"],
        },
    )
    return [
        StarPoint(
            id      = h["_source"]["id"],
            title   = h["_source"]["title"],
            authors = h["_source"].get("authors", ""),
            year    = h["_source"].get("year"),
            cite    = h["_source"].get("citations", 0),
            cluster = h["_source"]["cluster_id"],
            color   = h["_source"].get("cluster_color", "#ffffff"),
            x       = h["_source"]["pos_x"],
            y       = h["_source"]["pos_y"],
            z       = h["_source"]["pos_z"],
        )
        for h in resp["hits"]["hits"]
    ]


async def get_paper_with_similar(
    es: AsyncElasticsearch,
    paper_id: str,
    k: int = 6,
) -> PaperDetail | None:
    """
    Fetch a paper by ID, then run kNN to find the k most similar papers.
    """
    try:
        doc = await es.get(index=INDEX, id=paper_id)
    except Exception:
        return None

    src       = doc["_source"]
    embedding = src.get("embedding", [])
    similar   = []

    if embedding:
        knn_resp = await es.search(
            index=INDEX,
            body={
                "knn": {
                    "field":          "embedding",
                    "query_vector":   embedding,
                    "k":              k + 1,        # +1 because the paper itself scores highest
                    "num_candidates": 50,
                },
                "_source": {"excludes": ["embedding"]},
                "size": k + 1,
            },
        )
        for hit in knn_resp["hits"]["hits"]:
            s = hit["_source"]
            if s["id"] != paper_id:
                similar.append(SimilarPaper(
                    id      = s["id"],
                    title   = s["title"],
                    authors = s.get("authors", ""),
                    year    = s.get("year"),
                    x       = s["pos_x"],
                    y       = s["pos_y"],
                    z       = s["pos_z"],
                ))

    return PaperDetail(
        id        = src["id"],
        title     = src["title"],
        authors   = src.get("authors", ""),
        year      = src.get("year"),
        citations = src.get("citations", 0),
        abstract  = src.get("abstract", ""),
        venue     = src.get("venue", ""),
        cluster   = src["cluster_id"],
        color     = src.get("cluster_color", "#ffffff"),
        x         = src["pos_x"],
        y         = src["pos_y"],
        z         = src["pos_z"],
        similar   = similar[:k],
    )


async def get_cluster_stats(es: AsyncElasticsearch) -> dict:
    """Aggregations used by the legend to show paper counts per cluster."""
    resp = await es.search(
        index=INDEX,
        body={
            "size": 0,
            "aggs": {
                "by_cluster": {
                    "terms": {"field": "cluster_id", "size": 20},
                    "aggs": {
                        "label":       {"terms": {"field": "cluster_label", "size": 1}},
                        "color":       {"terms": {"field": "cluster_color", "size": 1}},
                        "avg_year":    {"avg":   {"field": "year"}},
                        "total_cites": {"sum":   {"field": "citations"}},
                    },
                }
            },
        },
    )
    clusters = []
    for b in resp["aggregations"]["by_cluster"]["buckets"]:
        clusters.append({
            "id":          b["key"],
            "label":       b["label"]["buckets"][0]["key"] if b["label"]["buckets"] else b["key"],
            "color":       b["color"]["buckets"][0]["key"] if b["color"]["buckets"] else "#ffffff",
            "count":       b["doc_count"],
            "avg_year":    round(b["avg_year"]["value"] or 0),
            "total_cites": int(b["total_cites"]["value"]),
        })
    return {"clusters": clusters}
