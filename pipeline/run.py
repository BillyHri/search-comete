"""
search-comete — pipeline/run.py
Orchestrates the full data pipeline:
  1. Fetch papers  (Semantic Scholar or arXiv)
  2. Embed         (sentence-transformers)
  3. UMAP → 3D     (umap-learn)
  4. Export        stars.json  (for fast frontend load)
  5. Index         Elasticsearch

Usage:
  # Quick test — 20 papers per topic (~500 total, ~3 min)
  python -m pipeline.run --limit 20

  # Full run — 200 papers per topic (~5000 total, ~30 min)
  python -m pipeline.run

  # Skip fetch (reuse cache), re-run embed + UMAP + index
  python -m pipeline.run --skip-fetch

  # Only export stars.json from cache (no ES needed)
  python -m pipeline.run --skip-fetch --skip-index
"""

import argparse
import json
import os
import numpy as np
from elasticsearch import Elasticsearch

from .fetch       import fetch_semantic_scholar, fetch_arxiv, deduplicate
from .embed       import load_model, embed_papers
from .umap_reduce import run_umap
from .index       import setup_index, build_docs, bulk_index

# ── Topic definitions ─────────────────────────────────────────────────────────
# Each entry: (search_query, cluster_id, cluster_label, hex_color)
TOPICS = [
    # ── Machine Learning ──────────────────────────────────────────────────────
    ("transformer attention mechanism neural network",       "ml",    "Machine Learning",   "#7c6dfa"),
    ("large language model GPT BERT fine-tuning",            "ml",    "Machine Learning",   "#7c6dfa"),
    ("reinforcement learning reward policy gradient",        "ml",    "Machine Learning",   "#7c6dfa"),
    ("diffusion generative model image synthesis",           "ml",    "Machine Learning",   "#7c6dfa"),
    ("graph neural network embedding representation",        "ml",    "Machine Learning",   "#7c6dfa"),
    ("convolutional neural network image classification",    "ml",    "Machine Learning",   "#7c6dfa"),
    ("natural language processing text generation",          "ml",    "Machine Learning",   "#7c6dfa"),
    ("federated learning privacy distributed training",      "ml",    "Machine Learning",   "#7c6dfa"),
    ("neural architecture search hyperparameter optimization","ml",   "Machine Learning",   "#7c6dfa"),
    ("knowledge distillation model compression pruning",     "ml",    "Machine Learning",   "#7c6dfa"),
    ("self-supervised contrastive representation learning",  "ml",    "Machine Learning",   "#7c6dfa"),
    ("multimodal learning vision language model",            "ml",    "Machine Learning",   "#7c6dfa"),
    ("object detection segmentation YOLO DETR",              "ml",    "Machine Learning",   "#7c6dfa"),
    ("speech recognition audio transformer wav2vec",         "ml",    "Machine Learning",   "#7c6dfa"),
    ("recommender system collaborative filtering embedding", "ml",    "Machine Learning",   "#7c6dfa"),

    # ── Biology ───────────────────────────────────────────────────────────────
    ("CRISPR gene editing genome protein",                   "bio",   "Biology",            "#3dd9a4"),
    ("protein folding structure prediction AlphaFold",       "bio",   "Biology",            "#3dd9a4"),
    ("single cell RNA sequencing transcriptomics",           "bio",   "Biology",            "#3dd9a4"),
    ("cancer immunotherapy tumor microenvironment",          "bio",   "Biology",            "#3dd9a4"),
    ("microbiome gut bacteria human health",                 "bio",   "Biology",            "#3dd9a4"),
    ("neuroscience brain neural circuit cognition",          "bio",   "Biology",            "#3dd9a4"),
    ("drug discovery molecular docking binding affinity",    "bio",   "Biology",            "#3dd9a4"),
    ("epigenetics DNA methylation chromatin regulation",     "bio",   "Biology",            "#3dd9a4"),
    ("evolution phylogenetics population genetics",          "bio",   "Biology",            "#3dd9a4"),
    ("stem cell differentiation regenerative medicine",      "bio",   "Biology",            "#3dd9a4"),
    ("viral infection pandemic COVID immunity",              "bio",   "Biology",            "#3dd9a4"),
    ("cell signaling pathway receptor kinase",               "bio",   "Biology",            "#3dd9a4"),
    ("metabolomics proteomics systems biology",              "bio",   "Biology",            "#3dd9a4"),
    ("aging longevity senescence telomere",                  "bio",   "Biology",            "#3dd9a4"),
    ("antibiotic resistance bacteria pathogen",              "bio",   "Biology",            "#3dd9a4"),

    # ── Physics ───────────────────────────────────────────────────────────────
    ("gravitational waves black hole LIGO merger",           "phys",  "Physics",            "#fa8c4f"),
    ("quantum computing superconducting qubit",              "phys",  "Physics",            "#fa8c4f"),
    ("dark energy cosmology galaxy survey telescope",        "phys",  "Physics",            "#fa8c4f"),
    ("high temperature superconductor condensed matter",     "phys",  "Physics",            "#fa8c4f"),
    ("particle physics Higgs boson LHC collider",            "phys",  "Physics",            "#fa8c4f"),
    ("quantum entanglement information cryptography",        "phys",  "Physics",            "#fa8c4f"),
    ("plasma fusion energy tokamak reactor",                 "phys",  "Physics",            "#fa8c4f"),
    ("semiconductor photonic crystal laser optics",          "phys",  "Physics",            "#fa8c4f"),
    ("neutron star pulsar magnetar X-ray",                   "phys",  "Physics",            "#fa8c4f"),
    ("dark matter detection axion WIMP",                     "phys",  "Physics",            "#fa8c4f"),
    ("topological insulator quantum hall effect",            "phys",  "Physics",            "#fa8c4f"),
    ("exoplanet atmosphere spectroscopy habitable",          "phys",  "Physics",            "#fa8c4f"),
    ("solar wind magnetic field space weather",              "phys",  "Physics",            "#fa8c4f"),
    ("quantum field theory renormalization group",           "phys",  "Physics",            "#fa8c4f"),
    ("graphene 2D material electronic properties",           "phys",  "Physics",            "#fa8c4f"),

    # ── Computer Science ──────────────────────────────────────────────────────
    ("distributed systems consensus fault tolerance",        "cs",    "Computer Science",   "#5ab4f5"),
    ("database query optimization index structure",          "cs",    "Computer Science",   "#5ab4f5"),
    ("computer vision object detection convolutional",       "cs",    "Computer Science",   "#5ab4f5"),
    ("cryptography blockchain zero knowledge proof",         "cs",    "Computer Science",   "#5ab4f5"),
    ("network security intrusion detection adversarial",     "cs",    "Computer Science",   "#5ab4f5"),
    ("compiler programming language type system",            "cs",    "Computer Science",   "#5ab4f5"),
    ("operating system kernel scheduling memory",            "cs",    "Computer Science",   "#5ab4f5"),
    ("human computer interaction user interface usability",  "cs",    "Computer Science",   "#5ab4f5"),
    ("cloud computing serverless microservices kubernetes",  "cs",    "Computer Science",   "#5ab4f5"),
    ("algorithm complexity graph theory combinatorics",      "cs",    "Computer Science",   "#5ab4f5"),
    ("software engineering testing verification formal",     "cs",    "Computer Science",   "#5ab4f5"),
    ("computer graphics rendering ray tracing 3D",          "cs",    "Computer Science",   "#5ab4f5"),
    ("robotics motion planning autonomous navigation",       "cs",    "Computer Science",   "#5ab4f5"),
    ("quantum algorithm error correction fault tolerant",    "cs",    "Computer Science",   "#5ab4f5"),
    ("information retrieval search ranking relevance",       "cs",    "Computer Science",   "#5ab4f5"),

    # ── Mathematics ───────────────────────────────────────────────────────────
    ("topology algebraic geometry manifold invariant",       "math",  "Mathematics",        "#f06ba8"),
    ("optimization convex gradient convergence",             "math",  "Mathematics",        "#f06ba8"),
    ("stochastic process probability measure theory",        "math",  "Mathematics",        "#f06ba8"),
    ("number theory prime distribution zeta function",       "math",  "Mathematics",        "#f06ba8"),
    ("partial differential equations numerical method",      "math",  "Mathematics",        "#f06ba8"),
    ("combinatorics graph theory extremal",                  "math",  "Mathematics",        "#f06ba8"),
    ("functional analysis operator Hilbert space",           "math",  "Mathematics",        "#f06ba8"),
    ("differential geometry Riemannian curvature",           "math",  "Mathematics",        "#f06ba8"),
    ("game theory mechanism design equilibrium",             "math",  "Mathematics",        "#f06ba8"),
    ("numerical analysis finite element method",             "math",  "Mathematics",        "#f06ba8"),

    # ── Chemistry ─────────────────────────────────────────────────────────────
    ("catalysis reaction mechanism synthesis organic",       "chem",  "Chemistry",          "#f9c74f"),
    ("polymer material nanoparticle surface",                "chem",  "Chemistry",          "#f9c74f"),
    ("electrochemistry battery lithium energy storage",      "chem",  "Chemistry",          "#f9c74f"),
    ("spectroscopy NMR mass spectrometry analytical",        "chem",  "Chemistry",          "#f9c74f"),
    ("computational chemistry density functional theory",    "chem",  "Chemistry",          "#f9c74f"),
    ("green chemistry sustainable synthesis solvent",        "chem",  "Chemistry",          "#f9c74f"),
    ("photochemistry solar cell dye sensitized",             "chem",  "Chemistry",          "#f9c74f"),
    ("enzyme kinetics biochemistry metabolic pathway",       "chem",  "Chemistry",          "#f9c74f"),

    # ── Economics & Social Science ────────────────────────────────────────────
    ("machine learning economics prediction causal",         "econ",  "Economics",          "#90e0ef"),
    ("market microstructure trading financial econometrics", "econ",  "Economics",          "#90e0ef"),
    ("game theory auction mechanism market design",          "econ",  "Economics",          "#90e0ef"),
    ("social network influence diffusion opinion",           "econ",  "Economics",          "#90e0ef"),
    ("natural language processing social media sentiment",   "econ",  "Economics",          "#90e0ef"),
    ("policy evaluation treatment effect causal inference",  "econ",  "Economics",          "#90e0ef"),

    # ── Climate & Environment ─────────────────────────────────────────────────
    ("climate change global warming carbon emissions",       "env",   "Environment",        "#52b788"),
    ("renewable energy wind solar grid storage",             "env",   "Environment",        "#52b788"),
    ("ocean circulation sea level temperature",              "env",   "Environment",        "#52b788"),
    ("biodiversity ecosystem species extinction",            "env",   "Environment",        "#52b788"),
    ("remote sensing satellite land use deforestation",      "env",   "Environment",        "#52b788"),
    ("air pollution particulate matter health urban",        "env",   "Environment",        "#52b788"),

    # ── Medicine & Healthcare ─────────────────────────────────────────────────
    ("clinical trial randomized controlled treatment",       "med",   "Medicine",           "#e63946"),
    ("medical imaging MRI CT deep learning diagnosis",       "med",   "Medicine",           "#e63946"),
    ("electronic health record prediction outcome",          "med",   "Medicine",           "#e63946"),
    ("mental health depression anxiety intervention",        "med",   "Medicine",           "#e63946"),
    ("surgical robotics minimally invasive procedure",       "med",   "Medicine",           "#e63946"),
    ("epidemiology disease surveillance outbreak",           "med",   "Medicine",           "#e63946"),
    ("genomics precision medicine biomarker",                "med",   "Medicine",           "#e63946"),
    ("vaccine immunization efficacy safety",                 "med",   "Medicine",           "#e63946"),
]

CACHE_DIR   = os.path.join(os.path.dirname(__file__), ".cache")
PAPERS_JSON = os.path.join(CACHE_DIR, "papers.json")
EMBED_NPY   = os.path.join(CACHE_DIR, "embeddings.npy")
COORDS_NPY  = os.path.join(CACHE_DIR, "coords.npy")
STARS_JSON  = os.path.join(os.path.dirname(__file__), "stars.json")


def main():
    parser = argparse.ArgumentParser(description="search-comete data pipeline")
    parser.add_argument("--limit",       type=int,  default=200, help="Papers per topic (default 200)")
    parser.add_argument("--skip-fetch",  action="store_true",    help="Load papers from cache")
    parser.add_argument("--skip-embed",  action="store_true",    help="Load embeddings from cache")
    parser.add_argument("--skip-umap",   action="store_true",    help="Load 3D coords from cache")
    parser.add_argument("--skip-index",  action="store_true",    help="Skip Elasticsearch indexing")
    parser.add_argument("--use-arxiv",   action="store_true",    help="Use arXiv instead of Semantic Scholar")
    parser.add_argument("--es-host",     default=os.getenv("ES_HOST", "http://localhost:9200"))
    args = parser.parse_args()

    os.makedirs(CACHE_DIR, exist_ok=True)

    print("\nsearch-comete pipeline")
    print("=" * 50)

    # ── 1. Fetch ──────────────────────────────────────────────────────────────
    if args.skip_fetch and os.path.exists(PAPERS_JSON):
        print("\n[1/5] Loading papers from cache…")
        with open(PAPERS_JSON) as f:
            cached = json.load(f)
        papers        = [c["paper"]   for c in cached]
        cluster_infos = [c["cluster"] for c in cached]
    else:
        print(f"\n[1/5] Fetching papers (limit={args.limit} per topic)…")
        fetch_fn = fetch_arxiv if args.use_arxiv else fetch_semantic_scholar
        source   = "arXiv" if args.use_arxiv else "Semantic Scholar"
        print(f"      Source: {source}")
        papers, cluster_infos = [], []
        for query, cid, clabel, ccolor in TOPICS:
            print(f"\n  [{cid.upper()}] {query[:55]}…")
            fetched = fetch_fn(query, limit=args.limit)
            print(f"  → {len(fetched)} papers")
            cl = {"id": cid, "label": clabel, "color": ccolor}
            for p in fetched:
                papers.append(p)
                cluster_infos.append(cl)

        papers, cluster_infos = deduplicate(papers, cluster_infos)
        print(f"\n  Total unique papers: {len(papers)}")

        with open(PAPERS_JSON, "w") as f:
            json.dump([{"paper": p, "cluster": c} for p, c in zip(papers, cluster_infos)], f)
        print(f"  Saved to {PAPERS_JSON}")

    # ── 2. Embed ──────────────────────────────────────────────────────────────
    if args.skip_embed and os.path.exists(EMBED_NPY):
        print("\n[2/5] Loading embeddings from cache…")
        embeddings = np.load(EMBED_NPY)
    else:
        print("\n[2/5] Generating embeddings…")
        model      = load_model()
        embeddings = embed_papers(papers, model)
        np.save(EMBED_NPY, embeddings)
        print(f"  Saved to {EMBED_NPY}")

    # ── 3. UMAP ───────────────────────────────────────────────────────────────
    if args.skip_umap and os.path.exists(COORDS_NPY):
        print("\n[3/5] Loading 3D coords from cache…")
        coords_3d = np.load(COORDS_NPY)
    else:
        print("\n[3/5] Running UMAP…")
        coords_3d = run_umap(embeddings)
        np.save(COORDS_NPY, coords_3d)
        print(f"  Saved to {COORDS_NPY}")

    # ── 4. Build docs + export stars.json ─────────────────────────────────────
    print("\n[4/5] Building documents…")
    docs = build_docs(papers, cluster_infos, embeddings, coords_3d)

    stars = [{
        "id":      d["id"],
        "title":   d["title"],
        "authors": d["authors"],
        "year":    d["year"],
        "cite":    d["citations"],
        "cluster": d["cluster_id"],
        "color":   d["cluster_color"],
        "x":       round(d["pos_x"], 4),
        "y":       round(d["pos_y"], 4),
        "z":       round(d["pos_z"], 4),
    } for d in docs]

    with open(STARS_JSON, "w") as f:
        json.dump(stars, f, separators=(",", ":"))
    size_kb = os.path.getsize(STARS_JSON) // 1024
    print(f"  Exported {len(stars)} stars → {STARS_JSON} ({size_kb} KB)")
    print(f"  Frontend will load this automatically via /api/stars or /static/stars.json")

    # ── 5. Index into Elasticsearch ───────────────────────────────────────────
    if not args.skip_index:
        print(f"\n[5/5] Indexing into Elasticsearch ({args.es_host})…")
        try:
            es = Elasticsearch(args.es_host)
            es.info()
            setup_index(es)
            n = bulk_index(es, docs)
            total = es.count(index="knowledge_galaxy")["count"]
            print(f"  Total in index: {total}")
        except Exception as e:
            print(f"  Elasticsearch not available: {e}")
            print("  stars.json was still exported — frontend can use that directly")
    else:
        print("\n[5/5] Skipping Elasticsearch indexing (--skip-index)")

    print(f"\n✓ Pipeline complete. {len(docs)} papers processed.")
    print(f"  Next: cd frontend && npm install && npm run dev")


if __name__ == "__main__":
    main()