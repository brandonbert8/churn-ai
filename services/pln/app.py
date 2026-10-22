"""Local inference over the trusted Colab export. No retraining or synthetic scores."""
import html
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import re
import secrets
import threading
import unicodedata

import joblib
import numpy as np
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field


def clean_text(value):
    # Same transformations as the exported preprocess.py; preserve negation.
    text = unicodedata.normalize("NFC", html.unescape(str(value)))
    replacements = [
        (r"<[^>]+>", " "),
        (r"https?://\S+|www\.\S+", " URL "),
        (r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", " EMAIL "),
        (r"(?<!\w)\+?\d[\d\s()-]{6,}\d(?!\w)", " TELEFONO "),
    ]
    for pattern, replacement in replacements:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", text).strip()


# Some notebook pickles reference this function under __main__.
import __main__  # noqa: E402
__main__.clean_text = clean_text

MODEL_DIR = Path(os.environ.get("PLN_MODEL_DIR", ".mastra/models/tigo")).resolve()
manifest = json.loads((MODEL_DIR / "manifest.json").read_text())
labels = json.loads((MODEL_DIR / "labels.json").read_text())
# Only load this project export: joblib files must never be accepted as uploads.
baseline = joblib.load(MODEL_DIR / "tfidf_logistic.joblib")
version = f"tfidf-lr:{manifest['corpus_sha256'][:12]}:{manifest['created_at_utc']}"
lock = threading.Lock()
beto = None
@asynccontextmanager
async def lifespan(_app):
    # Signal readiness only after loading BETO: no cold model load in a 15s tool call.
    if os.environ.get("PLN_PRELOAD_BETO", "true") == "true":
        await asyncio.to_thread(load_beto)
    yield


app = FastAPI(title="Tigo PLN experimental", docs_url=None, redoc_url=None, lifespan=lifespan)


class AnalyzeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=10000)
    includeEmbedding: bool = False


def load_beto():
    global beto
    if beto is None:
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        torch.set_num_threads(int(os.environ.get("PLN_TORCH_THREADS", "2")))
        tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR / "beto", local_files_only=True)
        model = AutoModelForSequenceClassification.from_pretrained(MODEL_DIR / "beto", local_files_only=True)
        model.eval()
        beto = (tokenizer, model)
    return beto


@app.get("/health")
def health():
    return {"status": "ok", "modelVersion": version, "productionReady": False}


@app.post("/analyze")
def analyze(payload: AnalyzeRequest, authorization: str | None = Header(default=None)):
    token = os.environ.get("PLN_API_TOKEN")
    if token and not secrets.compare_digest(authorization or "", f"Bearer {token}"):
        raise HTTPException(status_code=401, detail="Unauthorized")
    text = clean_text(payload.text)
    if not text:
        raise HTTPException(status_code=422, detail="Empty cleaned text")
    probabilities = baseline.predict_proba([text])[0]
    # sklearn classes are encoded IDs in the Colab pipeline.
    classes = [labels[int(index)] for index in baseline.classes_]
    scores = dict(zip(classes, map(float, probabilities)))
    result = {
        "category": max(scores, key=scores.get), "scores": scores,
        "modelVersion": version,
        "calibrated": bool(manifest.get("probabilities_calibrated", False)),
        "productionReady": bool(manifest.get("production_ready", False)),
    }
    if payload.includeEmbedding:
        import torch
        with lock, torch.inference_mode():
            tokenizer, model = load_beto()
            inputs = tokenizer(text, return_tensors="pt", truncation=True,
                               max_length=manifest["max_length"], return_special_tokens_mask=True)
            special = inputs.pop("special_tokens_mask")
            hidden = model.bert(**inputs).last_hidden_state
            mask = (inputs["attention_mask"] * (1 - special)).unsqueeze(-1)
            vector = ((hidden * mask).sum(1) / mask.sum(1).clamp(min=1))[0].numpy()
            if not np.isfinite(vector).all():
                raise HTTPException(status_code=500, detail="Invalid embedding")
            result["embedding"] = {
                "modelVersion": f"beto-finetuned:{manifest['model_revision']}:{manifest['corpus_sha256'][:12]}",
                "dimensions": int(vector.shape[0]),
                "pooling": "mean excluding padding and special tokens",
                "semanticSearchValidated": False,
                "vector": vector.tolist(),
            }
    return result
