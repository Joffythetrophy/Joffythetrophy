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
    if not payload.signature or len(payload.signature) &lt; 44:
        raise HTTPException(status_code=400, detail="Invalid signature")
    try:
        await db.tx_logs.insert_one(payload.dict())
        return payload
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to log transaction: {e}")

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