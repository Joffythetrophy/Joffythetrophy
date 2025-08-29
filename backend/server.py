from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
import uuid
from datetime import datetime, timezone

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection (must use env)
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Create main app
app = FastAPI()

# API router with required '/api' prefix
api_router = APIRouter(prefix="/api")

# Helper functions for datetime serialization

def now_utc_iso():
    return datetime.now(timezone.utc).isoformat()

# Models
class StatusCheck(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: str = Field(default_factory=now_utc_iso)

class StatusCheckCreate(BaseModel):
    client_name: str

class WalletConnectionLog(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    wallet_address: str
    wallet_name: str
    user_agent: Optional[str] = None
    connected_at: str = Field(default_factory=now_utc_iso)

class TransactionMetadata(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    signature: str
    wallet_address: str
    transaction_type: str = Field(pattern=r"^(SOL_TRANSFER|SPL_TRANSFER|OTHER)$")
    amount: Optional[float] = Field(default=None)
    recipient: Optional[str] = None
    token_mint: Optional[str] = None
    network: str = Field(default="devnet")
    created_at: str = Field(default_factory=now_utc_iso)
    additional_data: Optional[Dict[str, Any]] = None

# Loss tracking models
class LossEventCreate(BaseModel):
    wallet_address: str
    amount: float
    currency: str  # e.g., SOL, USDC, CRT

class LossEvent(LossEventCreate):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    savings: float
    liquidity: float
    created_at: str = Field(default_factory=now_utc_iso)

# Routes
@api_router.get("/")
async def root():
    return {"message": "Hello World"}

@api_router.get("/health")
async def health():
    return {"status": "ok", "time": now_utc_iso()}

@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_obj = StatusCheck(client_name=input.client_name)
    await db.status_checks.insert_one(status_obj.dict())
    return status_obj

@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    items = await db.status_checks.find().sort("timestamp", -1).to_list(1000)
    # Pydantic will ignore _id
    return [StatusCheck(**item) for item in items]

@api_router.post("/wallet/connect", response_model=WalletConnectionLog)
async def log_wallet_connection(payload: WalletConnectionLog):
    try:
        await db.wallet_connections.insert_one(payload.dict())
        return payload
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to log wallet connection: {e}")

@api_router.post("/transactions/log", response_model=TransactionMetadata)
async def log_transaction(payload: TransactionMetadata):
    # basic format checks
    if not payload.signature or len(payload.signature) < 44:
        raise HTTPException(status_code=400, detail="Invalid signature")
    try:
        await db.tx_logs.insert_one(payload.dict())
        return payload
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to log transaction: {e}")

# ========= Loss Tracking =========
@api_router.post("/gaming/loss", response_model=LossEvent)
async def record_loss(payload: LossEventCreate):
    """Record a loss event and compute 70/30 split (savings/liquidity)."""
    try:
        if payload.amount <= 0:
            raise HTTPException(status_code=400, detail="Amount must be positive")
        savings = round(payload.amount * 0.7, 8)
        liquidity = round(payload.amount * 0.3, 8)
        doc = LossEvent(
            wallet_address=payload.wallet_address,
            amount=payload.amount,
            currency=payload.currency.upper(),
            savings=savings,
            liquidity=liquidity,
        )
        await db.loss_events.insert_one(doc.dict())
        return doc
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to record loss: {e}")

@api_router.get("/gaming/summary")
async def loss_summary(wallet_address: str):
    """Return totals per currency for savings, liquidity and total losses."""
    try:
        cursor = db.loss_events.find({"wallet_address": wallet_address})
        items = await cursor.to_list(length=10000)
        totals: Dict[str, Dict[str, float]] = {}
        for it in items:
            cur = it.get("currency", "?")
            if cur not in totals:
                totals[cur] = {"total": 0.0, "savings": 0.0, "liquidity": 0.0}
            totals[cur]["total"] += float(it.get("amount", 0))
            totals[cur]["savings"] += float(it.get("savings", 0))
            totals[cur]["liquidity"] += float(it.get("liquidity", 0))
        # round
        for cur in totals:
            for k in totals[cur]:
                totals[cur][k] = round(totals[cur][k], 8)
        return {"wallet_address": wallet_address, "totals": totals}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch summary: {e}")

# Include router
app.include_router(api_router)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

# Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()