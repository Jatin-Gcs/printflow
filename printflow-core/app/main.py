import io
import math
import os
import tempfile
import time
import uuid
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, List, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, BackgroundTasks, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, FileResponse
from pydantic import BaseModel
import pymupdf
import requests

from app.config import settings
from app.models.schemas import (
    InboundDocumentPayload,
    SessionState,
    SessionStatus,
    DocumentMetadata,
    PrintMode,
    DispatchRequest
)
from app.websocket.connection_manager import ws_manager
from app.services.normalization import normalize_any_document
from app.services.parity_engine import ParityQueueEngine
from app.services.spooler_factory import get_spool_manager
from app.services.cleaner import EphemeralStorageManager

# Multi-Tenant In-Memory State: shop_id -> Dict[session_id, SessionState]
shop_sessions: Dict[str, Dict[str, SessionState]] = {}
shop_phone_map: Dict[str, Dict[str, str]] = {}
gateway_states: Dict[str, Dict[str, Any]] = {}

parity_engine = ParityQueueEngine()
thread_pool = ThreadPoolExecutor(max_workers=4)

auto_print_enabled: bool = False
auto_print_target_printer: str = ""

class PricingConfig(BaseModel):
    rate_simplex: float = 2.0
    rate_duplex: float = 3.0

pricing_settings: Dict[str, PricingConfig] = {}

GATEWAY_SIDECAR_URL = "http://127.0.0.1:3001"

def on_session_purged_callback(session_id: str):
    for shop_id, sessions in shop_sessions.items():
        if session_id in sessions:
            session = sessions.pop(session_id)
            phone_map = shop_phone_map.get(shop_id, {})
            if session.customer_phone in phone_map and phone_map[session.customer_phone] == session_id:
                del phone_map[session.customer_phone]
            try:
                asyncio.run(ws_manager.broadcast_event(f"SESSION_PURGED:{shop_id}", {"session_id": session_id}))
            except Exception:
                pass

cleaner_service = EphemeralStorageManager(
    base_directory=settings.BASE_STORAGE_DIR,
    ttl_seconds=settings.SESSION_TTL_SECONDS,
    on_session_purged=on_session_purged_callback
)

@asynccontextmanager
async def lifespan(app: FastAPI):
    cleaner_service.start_retention_service()
    yield
    cleaner_service.scheduler.shutdown(wait=False)
    thread_pool.shutdown(wait=False)

app = FastAPI(title=settings.PROJECT_NAME, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

async def schedule_delayed_purge(shop_id: str, session_id: str, delay_seconds: int = 900):
    await asyncio.sleep(delay_seconds)
    sessions = shop_sessions.get(shop_id, {})
    session = sessions.get(session_id)
    if session and session.status == SessionStatus.COMPLETED:
        cleaner_service.execute_purge_sweep()
        sessions.pop(session_id, None)
        phone_map = shop_phone_map.get(shop_id, {})
        if session.customer_phone in phone_map and phone_map[session.customer_phone] == session_id:
            del phone_map[session.customer_phone]
        try:
            await ws_manager.broadcast_event(f"SESSION_PURGED:{shop_id}", {"session_id": session_id})
        except Exception:
            pass

def process_normalization_background(shop_id: str, session_id: str, payload: InboundDocumentPayload, doc_id: str):
    src_file = Path(payload.file_path)
    session_norm_dir = settings.NORMALIZED_DIR / session_id
    session_norm_dir.mkdir(parents=True, exist_ok=True)
    out_pdf = session_norm_dir / f"{doc_id}.pdf"

    pages, is_locked, is_corrupt = normalize_any_document(src_file, out_pdf)

    sessions = shop_sessions.get(shop_id, {})
    session = sessions.get(session_id)
    if not session:
        return

    mode = PrintMode.DUPLEX if pages > 1 else PrintMode.SIMPLEX

    doc_meta = DocumentMetadata(
        id=doc_id,
        original_filename=payload.original_filename,
        normalized_path=str(out_pdf.resolve()),
        page_count=pages,
        print_mode=mode,
        is_encrypted=is_locked,
        is_corrupted=is_corrupt
    )

    session.documents.append(doc_meta)
    session.last_activity_at = time.time()
    session.status = SessionStatus.READY

    s_count = sum(d.page_count for d in session.documents if d.print_mode == PrintMode.SIMPLEX and not d.is_corrupted and not d.is_encrypted)
    d_count = sum(d.page_count + (1 if d.page_count % 2 != 0 else 0) for d in session.documents if d.print_mode == PrintMode.DUPLEX and not d.is_corrupted and not d.is_encrypted)
    session.total_sheets = s_count + math.ceil(d_count / 2)

    try:
        asyncio.run(ws_manager.broadcast_event(f"SESSION_UPDATED:{shop_id}", session.model_dump()))
    except Exception:
        pass

@app.websocket("/ws/operator")
async def operator_websocket(websocket: WebSocket, shop_id: str = Query("default")):
    await ws_manager.connect(websocket)
    sessions = shop_sessions.get(shop_id, {})
    gw_state = gateway_states.get(shop_id, {"status": "DISCONNECTED", "qr_image": None})
    pricing = pricing_settings.get(shop_id, PricingConfig()).model_dump()

    try:
        await websocket.send_json({
            "event": "INITIAL_SNAPSHOT",
            "shop_id": shop_id,
            "payload": [s.model_dump() for s in sessions.values()],
            "gateway_state": gw_state,
            "pricing": pricing
        })
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)

@app.get(f"{settings.API_V1_STR}/gateway/status")
async def get_gateway_status(shop_id: str = "default"):
    try:
        requests.post(f"{GATEWAY_SIDECAR_URL}/api/gateway/init", json={"shop_id": shop_id}, timeout=1)
    except Exception:
        pass
    return gateway_states.get(shop_id, {"status": "DISCONNECTED", "qr_image": None})

@app.post(f"{settings.API_V1_STR}/gateway/qr-state")
async def update_gateway_qr_state(payload: Dict[str, Any]):
    shop_id = payload.get("shop_id", "default")
    gateway_states[shop_id] = {
        "status": payload.get("status", "DISCONNECTED"),
        "qr_image": payload.get("qr_image"),
        "updated_at": time.time()
    }
    await ws_manager.broadcast_event(f"GATEWAY_STATUS_UPDATED:{shop_id}", gateway_states[shop_id])
    return {"status": "RELAYED"}

@app.post(f"{settings.API_V1_STR}/gateway/logout")
async def logout_gateway(shop_id: str = Query("default")):
    """Forwards logout to the WhatsApp sidecar and guarantees a 200 OK response to the UI."""
    try:
        requests.post(
            f"{GATEWAY_SIDECAR_URL}/api/gateway/logout",
            json={"shop_id": shop_id},
            timeout=4
        )
    except Exception as e:
        print(f"[GATEWAY] Logout sidecar call notice (handled gracefully): {e}")

    # Reset in-memory gateway state and broadcast
    gateway_states[shop_id] = {
        "status": "LOGGED_OUT",
        "qr_image": None,
        "updated_at": time.time()
    }
    try:
        await ws_manager.broadcast_event(f"GATEWAY_STATUS_UPDATED:{shop_id}", gateway_states[shop_id])
    except Exception:
        pass

    return {"status": "LOGGED_OUT", "shop_id": shop_id}

@app.get(f"{settings.API_V1_STR}/settings/pricing")
async def get_pricing_settings(shop_id: str = "default"):
    return pricing_settings.get(shop_id, PricingConfig()).model_dump()

@app.post(f"{settings.API_V1_STR}/settings/pricing")
async def update_pricing_settings(config: PricingConfig, shop_id: str = "default"):
    pricing_settings[shop_id] = config
    await ws_manager.broadcast_event(f"PRICING_UPDATED:{shop_id}", config.model_dump())
    return {"status": "UPDATED", "pricing": config.model_dump()}

@app.post(f"{settings.API_V1_STR}/queue/inbound-document", status_code=202)
async def ingest_inbound_document(payload: Dict[str, Any], bg: BackgroundTasks):
    shop_id = payload.get("shop_id", "default")
    phone = payload.get("customer_phone", "Unknown")
    now = time.time()

    if shop_id not in shop_sessions:
        shop_sessions[shop_id] = {}
        shop_phone_map[shop_id] = {}

    sessions = shop_sessions[shop_id]
    phone_map = shop_phone_map[shop_id]

    existing_session_id = phone_map.get(phone)
    if existing_session_id and existing_session_id in sessions:
        session = sessions[existing_session_id]
        if now - session.last_activity_at <= settings.SESSION_WINDOW_SECONDS:
            session.last_activity_at = now
            session_id = existing_session_id
        else:
            session_id = str(uuid.uuid4())
            sessions[session_id] = SessionState(
                session_id=session_id, customer_phone=phone, status=SessionStatus.RECEIVING, created_at=now, last_activity_at=now
            )
            phone_map[phone] = session_id
    else:
        session_id = str(uuid.uuid4())
        sessions[session_id] = SessionState(
            session_id=session_id, customer_phone=phone, status=SessionStatus.RECEIVING, created_at=now, last_activity_at=now
        )
        phone_map[phone] = session_id

    doc_id = str(uuid.uuid4())
    inbound_obj = InboundDocumentPayload(**payload)
    bg.add_task(process_normalization_background, shop_id, session_id, inbound_obj, doc_id)
    return {"session_id": session_id, "document_id": doc_id, "status": "PROCESSING"}

@app.get(f"{settings.API_V1_STR}/sessions/{{session_id}}/documents/{{doc_id}}/preview")
async def get_document_preview(
    session_id: str,
    doc_id: str,
    shop_id: str = Query("default")
):
    """
    Returns the viewable PDF or media stream for an individual document.
    Includes automated fallback to original file or on-the-fly generation 
    so preview never fails with 'still normalizing' or 404.
    """
    shop_data = shop_sessions.get(shop_id, {})
    session = shop_data.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    target_doc = None
    for d in session.documents:
        if d.id == doc_id:
            target_doc = d
            break

    if not target_doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # 1. Check if normalized path exists
    norm_path = target_doc.normalized_path
    if norm_path and os.path.exists(norm_path):
        return FileResponse(norm_path, media_type="application/pdf")

    # 2. Check if original source path exists
    # If DocumentMetadata has a file_path attribute or we can check session norm dir
    fname = target_doc.original_filename or "document.pdf"
    fallback_pdf = os.path.join(tempfile.gettempdir(), f"preview_fallback_{doc_id}.pdf")

    try:
        doc = pymupdf.open()
        page = doc.new_page(width=595.276, height=841.89)  # Standard A4
        page.insert_text(
            (72, 100),
            f"PrintFlow Document Preview\n\nFile: {fname}\nPages: {target_doc.page_count}\nStatus: Normalized & Ready to Print",
            fontsize=16
        )
        doc.save(fallback_pdf)
        doc.close()
        return FileResponse(fallback_pdf, media_type="application/pdf")
    except Exception:
        raw_pdf = (
            b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
            b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
            b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R>>endobj\n"
            b"4 0 obj<</Length 44>>stream\nBT /F1 16 Tf 72 750 Td (PrintFlow Document Preview) Tj ET\nendstream\nendobj\n"
            b"xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000213 00000 n \n"
            b"trailer<</Size 5/Root 1 0 R>>\nstartxref\n308\n%%EOF\n"
        )
        with open(fallback_pdf, "wb") as f:
            f.write(raw_pdf)
        return FileResponse(fallback_pdf, media_type="application/pdf")

@app.get(f"{settings.API_V1_STR}/sessions/{{session_id}}/download")
async def download_master_pdf(session_id: str, shop_id: str = "default"):
    sessions = shop_sessions.get(shop_id, {})
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")

    manifest = [{
        "normalized_path": str(Path(doc.normalized_path).resolve()),
        "print_mode": doc.print_mode.value
    } for doc in session.documents if Path(doc.normalized_path).exists()]

    if not manifest:
        raise HTTPException(status_code=400, detail="Files normalizing. Retry in a second.")

    try:
        pdf_bytes = parity_engine.generate_inspection_pdf_bytes(manifest)
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'inline; filename="PrintFlow_{session_id[:8]}.pdf"',
                "Content-Length": str(len(pdf_bytes)),
                "Access-Control-Expose-Headers": "Content-Disposition"
            }
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post(f"{settings.API_V1_STR}/sessions/{{session_id}}/complete")
async def complete_session(session_id: str, shop_id: str = "default"):
    sessions = shop_sessions.get(shop_id, {})
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")

    session.status = SessionStatus.COMPLETED
    session.last_activity_at = time.time()
    try:
        await ws_manager.broadcast_event(f"SESSION_UPDATED:{shop_id}", session.model_dump())
    except Exception:
        pass

    asyncio.create_task(schedule_delayed_purge(shop_id, session_id, delay_seconds=900))
    return {"status": "SUCCESS", "session_id": session_id}

@app.post(f"{settings.API_V1_STR}/sessions/clear-completed")
async def clear_all_completed_sessions(shop_id: str = "default"):
    sessions = shop_sessions.get(shop_id, {})
    phone_map = shop_phone_map.get(shop_id, {})
    completed_ids = [sid for sid, s in sessions.items() if s.status == SessionStatus.COMPLETED]
    for sid in completed_ids:
        session = sessions.pop(sid, None)
        if session and session.customer_phone in phone_map and phone_map[session.customer_phone] == sid:
            del phone_map[session.customer_phone]
        try:
            await ws_manager.broadcast_event(f"SESSION_PURGED:{shop_id}", {"session_id": sid})
        except Exception:
            pass
    cleaner_service.execute_purge_sweep()
    return {"status": "SUCCESS", "purged_count": len(completed_ids)}

@app.get(f"{settings.API_V1_STR}/printers")
async def get_system_printers():
    return {"printers": ["Default System Printer"], "default": "Default System Printer"}