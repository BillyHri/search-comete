"""
search-comete — models.py
Pydantic models shared across the backend.
"""

from pydantic import BaseModel, Field
from typing import Optional


class Paper(BaseModel):
    id:            str
    title:         str
    abstract:      Optional[str] = ""
    authors:       Optional[str] = ""
    year:          Optional[int] = None
    citations:     Optional[int] = 0
    venue:         Optional[str] = ""
    cluster_id:    str
    cluster_label: Optional[str] = ""
    cluster_color: Optional[str] = "#ffffff"
    pos_x:         float = 0.0
    pos_y:         float = 0.0
    pos_z:         float = 0.0


class SearchResult(BaseModel):
    id:       str
    title:    str
    authors:  Optional[str] = ""
    year:     Optional[int] = None
    cite:     Optional[int] = 0
    abstract: Optional[str] = ""
    cluster:  str
    color:    Optional[str] = "#ffffff"
    x:        float = 0.0
    y:        float = 0.0
    z:        float = 0.0
    score:    float = 0.0


class SearchResponse(BaseModel):
    total:   int
    results: list[SearchResult]
    query:   str


class StarPoint(BaseModel):
    """Lightweight star for the galaxy render — no embedding."""
    id:      str
    title:   str
    authors: Optional[str] = ""
    year:    Optional[int] = None
    cite:    Optional[int] = 0
    cluster: str
    color:   Optional[str] = "#ffffff"
    x:       float
    y:       float
    z:       float


class SimilarPaper(BaseModel):
    id:      str
    title:   str
    authors: Optional[str] = ""
    year:    Optional[int] = None
    x:       float = 0.0
    y:       float = 0.0
    z:       float = 0.0


class PaperDetail(BaseModel):
    id:       str
    title:    str
    authors:  Optional[str] = ""
    year:     Optional[int] = None
    citations:Optional[int] = 0
    abstract: Optional[str] = ""
    venue:    Optional[str] = ""
    cluster:  str
    color:    Optional[str] = "#ffffff"
    x:        float = 0.0
    y:        float = 0.0
    z:        float = 0.0
    similar:  list[SimilarPaper] = Field(default_factory=list)
