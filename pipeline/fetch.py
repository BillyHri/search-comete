"""
search-comete — pipeline/fetch.py
Fetch papers from Semantic Scholar (default) or arXiv.
Both are free with no API key required.
"""

import time
import uuid
import requests
import xml.etree.ElementTree as ET


# ── Semantic Scholar ──────────────────────────────────────────────────────────

SS_URL    = "https://api.semanticscholar.org/graph/v1/paper/search"
SS_FIELDS = "paperId,title,abstract,authors,year,citationCount,venue"


def fetch_semantic_scholar(query: str, limit: int = 200) -> list[dict]:
    """
    Pull papers from the Semantic Scholar Academic Graph API.
    Free, no key needed for moderate volumes (< 100 req/min).
    Docs: https://api.semanticscholar.org/api-docs/
    """
    papers, offset, batch = [], 0, min(100, limit)

    while len(papers) < limit:
        try:
            r = requests.get(SS_URL, params={
                "query":  query,
                "fields": SS_FIELDS,
                "limit":  batch,
                "offset": offset,
            }, timeout=15)

            if r.status_code == 429:
                print("    [SS] Rate limited — sleeping 30s…")
                time.sleep(30)
                continue
            if r.status_code != 200:
                print(f"    [SS] HTTP {r.status_code} for '{query[:40]}'")
                break

            data = r.json().get("data", [])
            if not data:
                break

            valid = [p for p in data if p.get("abstract") and p.get("title")]
            papers.extend(valid)
            offset += batch

            if len(data) < batch:
                break  # exhausted results

            time.sleep(0.4)

        except Exception as e:
            print(f"    [SS] Error: {e}")
            time.sleep(5)

    return papers[:limit]


# ── arXiv ─────────────────────────────────────────────────────────────────────

ARXIV_URL = "http://export.arxiv.org/api/query"
ATOM_NS   = "http://www.w3.org/2005/Atom"


def fetch_arxiv(query: str, limit: int = 200) -> list[dict]:
    """
    Pull papers from the arXiv open-access API.
    Free, no key needed. Good coverage of CS / physics / maths / bio.
    Docs: https://arxiv.org/help/api/user-manual
    """
    papers, start, batch = [], 0, min(100, limit)

    while len(papers) < limit:
        try:
            r    = requests.get(ARXIV_URL, params={
                "search_query": f"all:{query}",
                "start":        start,
                "max_results":  batch,
            }, timeout=20)
            root    = ET.fromstring(r.text)
            entries = root.findall(f"{{{ATOM_NS}}}entry")

            if not entries:
                break

            for e in entries:
                title    = (e.findtext(f"{{{ATOM_NS}}}title")   or "").replace("\n", " ").strip()
                abstract = (e.findtext(f"{{{ATOM_NS}}}summary") or "").replace("\n", " ").strip()
                year_raw = e.findtext(f"{{{ATOM_NS}}}published") or "2020"

                # FIX: store authors as a comma-joined string to match the Paper model (authors: str).
                # Previously this returned list[dict] which caused a type mismatch when
                # the pipeline tried to write it into the Paper model or index it into ES.
                author_names = [
                    (a.findtext(f"{{{ATOM_NS}}}name") or "").strip()
                    for a in e.findall(f"{{{ATOM_NS}}}author")
                ]
                authors_str = ", ".join(n for n in author_names if n)

                if title and abstract:
                    papers.append({
                        "paperId":       e.findtext(f"{{{ATOM_NS}}}id") or str(uuid.uuid4()),
                        "title":         title,
                        "abstract":      abstract,
                        # Consistent string format — matches what the pipeline and Paper model expect
                        "authors":       authors_str,
                        "year":          int(year_raw[:4]),
                        "citationCount": 0,
                        "venue":         "arXiv",
                    })

            start += batch
            if len(entries) < batch:
                break

            time.sleep(1.0)

        except Exception as e:
            print(f"    [arXiv] Error: {e}")
            break

    return papers[:limit]


def normalize_authors(paper: dict) -> str:
    """
    Normalize the authors field from either source into a plain comma-joined string.
    Semantic Scholar returns authors as list[dict] with a 'name' key.
    arXiv (after the fix above) already returns a string, but this handles both cases.
    Call this in the pipeline before building the Paper object.
    """
    authors = paper.get("authors", "")
    if isinstance(authors, list):
        return ", ".join(
            (a.get("name") or a) if isinstance(a, dict) else str(a)
            for a in authors
        )
    return authors or ""


# ── Deduplication ─────────────────────────────────────────────────────────────

def deduplicate(papers: list[dict], cluster_infos: list[dict]) -> tuple[list[dict], list[dict]]:
    """Remove papers with duplicate titles. Preserves order."""
    seen, out_p, out_c = set(), [], []
    for p, c in zip(papers, cluster_infos):
        key = (p.get("title") or "").lower().strip()
        if key and key not in seen:
            seen.add(key)
            out_p.append(p)
            out_c.append(c)
    return out_p, out_c