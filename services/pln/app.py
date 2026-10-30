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
from typing import Literal
import unicodedata

import joblib
import numpy as np
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, AwareDatetime
from fastapi import Query
from services.pln import snowflake_data
from services.pln.customer_ranking import rank_customers


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

MODEL_DIR = Path(os.environ.get("PLN_MODEL_DIR", "tigo_pln_modelo")).resolve()
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
    return {"status": "ok", "modelVersion": version, "productionReady": False,
            "modelDirectory": MODEL_DIR.name, "snowflake": snowflake_data.configuration_status()}


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


class CaseRequest(BaseModel):
    customerId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,80}$")
    cutoff: AwareDatetime


def check_evidence_access(authorization):
    token = os.environ.get("CHURN_EVIDENCE_API_TOKEN")
    if not token or not secrets.compare_digest(authorization or "", f"Bearer {token}"):
        raise HTTPException(status_code=401, detail={"code": "UNAUTHORIZED", "message": "Acceso no autorizado a la evidencia."})


def source_operation(operation):
    try:
        with snowflake_data.connect() as connection:
            return operation(connection)
    except snowflake_data.SourceError as error:
        raise HTTPException(status_code=error.status, detail={"code": error.code, "message": error.message}) from error


@app.get("/customers")
def customers(cutoff: AwareDatetime, query: str = Query(default="", pattern=r"^[A-Za-z0-9_-]{0,80}$"), offset: int = Query(default=0, ge=0, le=1000000), authorization: str | None = Header(default=None)):
    check_evidence_access(authorization)
    return source_operation(lambda connection: snowflake_data.list_customers(connection, cutoff.isoformat(), query, offset))


@app.post("/case-snapshot")
def case_snapshot(payload: CaseRequest, authorization: str | None = Header(default=None)):
    check_evidence_access(authorization)
    return source_operation(lambda connection: snowflake_data.case_snapshot(connection, payload.customerId, payload.cutoff.isoformat()))


@app.post("/churn-score")
def churn_score(payload: CaseRequest, authorization: str | None = Header(default=None)):
    check_evidence_access(authorization)
    return {"status": "unavailable", "risk": None, "reason": "Los artefactos tigo_pln_modelo clasifican reclamos; no contienen un predictor de abandono a 90 días."}


class CustomerRankingRequest(BaseModel):
    cutoff: AwareDatetime
    limit: int = Field(default=10, ge=1, le=50)
    metric: Literal['complaints', 'tickets'] = 'complaints'
    minTickets: int = Field(default=1, ge=1, le=1000000)
    lookbackDays: int | None = Field(default=None, ge=1, le=3650)
    activeOnly: bool = True


@app.post('/customer-ranking')
def customer_ranking(payload: CustomerRankingRequest, authorization: str | None = Header(default=None)):
    check_evidence_access(authorization)
    return source_operation(lambda connection: rank_customers(connection, payload.cutoff.isoformat(), payload.limit, payload.metric, payload.minTickets, payload.lookbackDays, payload.activeOnly))
