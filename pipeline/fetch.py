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
                authors  = ", ".join(
                    a.findtext(f"{{{ATOM_NS}}}name") or ""
                    for a in e.findall(f"{{{ATOM_NS}}}author")
                )
                if title and abstract:
                    papers.append({
                        "paperId":       e.findtext(f"{{{ATOM_NS}}}id") or str(uuid.uuid4()),
                        "title":         title,
                        "abstract":      abstract,
                        "authors":       [{"name": n.strip()} for n in authors.split(",")],
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
