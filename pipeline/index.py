"""
search-comete — pipeline/index.py
Bulk-index processed papers into Elasticsearch.
"""

import uuid
import numpy as np
from elasticsearch import Elasticsearch, helpers

INDEX = "knowledge_galaxy"
EMBED_DIMS = 384

MAPPING = {
    "mappings": {
        "properties": {
            "id":             {"type": "keyword"},
            "title":          {"type": "text", "fields": {"raw": {"type": "keyword"}}},
            "abstract":       {"type": "text"},
            "authors":        {"type": "text"},
            "year":           {"type": "integer"},
            "citations":      {"type": "integer"},
            "venue":          {"type": "keyword"},
            "cluster_id":     {"type": "keyword"},
            "cluster_label":  {"type": "keyword"},
            "cluster_color":  {"type": "keyword"},
            # Pre-computed 3D position from UMAP — used directly by Three.js
            "pos_x":          {"type": "float"},
            "pos_y":          {"type": "float"},
            "pos_z":          {"type": "float"},
            # Full embedding for kNN semantic search
            "embedding": {
                "type":       "dense_vector",
                "dims":       EMBED_DIMS,
                "index":      True,
                "similarity": "cosine",
            },
        }
    },
    "settings": {
        "number_of_shards":   1,
        "number_of_replicas": 0,
    },
}


def setup_index(es: Elasticsearch, recreate: bool = True):
    if es.indices.exists(index=INDEX):
        if recreate:
            print(f"  Deleting existing index '{INDEX}'…")
            es.indices.delete(index=INDEX)
        else:
            print(f"  Index '{INDEX}' already exists — skipping create")
            return
    print(f"  Creating index '{INDEX}'…")
    es.indices.create(index=INDEX, body=MAPPING)


def build_docs(
    papers:       list[dict],
    cluster_infos:list[dict],
    embeddings:   np.ndarray,
    coords_3d:    np.ndarray,
) -> list[dict]:
    """Assemble Elasticsearch documents from all pipeline outputs."""
    docs = []
    for i, (paper, cl) in enumerate(zip(papers, cluster_infos)):
        author_names = [a.get("name", "") for a in (paper.get("authors") or [])]
        docs.append({
            "id":            paper.get("paperId") or str(uuid.uuid4()),
            "title":         paper.get("title", ""),
            "abstract":      (paper.get("abstract") or "")[:2000],
            "authors":       ", ".join(author_names[:5]),
            "year":          paper.get("year") or 0,
            "citations":     paper.get("citationCount") or 0,
            "venue":         paper.get("venue") or "",
            "cluster_id":    cl["id"],
            "cluster_label": cl["label"],
            "cluster_color": cl["color"],
            "pos_x":         float(coords_3d[i, 0]),
            "pos_y":         float(coords_3d[i, 1]),
            "pos_z":         float(coords_3d[i, 2]),
            "embedding":     embeddings[i].tolist(),
        })
    return docs


def bulk_index(es: Elasticsearch, docs: list[dict], chunk_size: int = 200):
    """Parallel bulk index, then refresh."""
    actions = [
        {"_index": INDEX, "_id": d["id"], "_source": d}
        for d in docs
    ]
    print(f"  Bulk indexing {len(actions)} documents…")
    ok_count, err_count = 0, 0
    for ok, info in helpers.parallel_bulk(es, actions, chunk_size=chunk_size, thread_count=4):
        if ok:
            ok_count += 1
        else:
            err_count += 1
            print(f"  Error: {info}")
    es.indices.refresh(index=INDEX)
    print(f"  Done — {ok_count} indexed, {err_count} errors")
    return ok_count
