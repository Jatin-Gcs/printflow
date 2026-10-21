import io
import math
import time
import uuid
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, List, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, FileResponse
import pymupdf

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

# In-memory queue state
active_sessions: Dict[str, SessionState] = {}
phone_to_session_map: Dict[str, str] = {}
parity_engine = ParityQueueEngine()
thread_pool = ThreadPoolExecutor(max_workers=4)

# --- Auto-Print State ---
auto_print_enabled: bool = False
auto_print_target_printer: str = ""

# --- Gateway Pairing State (Declared before endpoints) ---
gateway_state: Dict[str, Any] = {
    "status": "DISCONNECTED",  # "SCAN_REQUIRED", "CONNECTED", "DISCONNECTED", "LOGGED_OUT"
    "qr_image": None,
    "updated_at": time.time()
}

def on_session_purged_callback(session_id: str):
    if session_id in active_sessions:
        session = active_sessions.pop(session_id)
        if session.customer_phone in phone_to_session_map:
            if phone_to_session_map[session.customer_phone] == session_id:
                del phone_to_session_map[session.customer_phone]

        try:
            asyncio.run(ws_manager.broadcast_event("SESSION_PURGED", {"session_id": session_id}))
            print(f"[CORE] Purged session {session_id} from memory and disk.")
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

async def schedule_delayed_purge(session_id: str, delay_seconds: int = 900):
    """Waits for delay_seconds (default 15m) and permanently shreds files if order was handed over."""
    await asyncio.sleep(delay_seconds)
    session = active_sessions.get(session_id)
    if session and session.status == SessionStatus.COMPLETED:
        cleaner_service.execute_purge_sweep()
        active_sessions.pop(session_id, None)
        if session.customer_phone in phone_to_session_map:
            if phone_to_session_map[session.customer_phone] == session_id:
                del phone_to_session_map[session.customer_phone]
        try:
            await ws_manager.broadcast_event("SESSION_PURGED", {"session_id": session_id})
            print(f"[CLEANER] Auto-purged completed session {session_id} after 15m retention.")
        except Exception:
            pass

def process_normalization_background(session_id: str, payload: InboundDocumentPayload, doc_id: str):
    src_file = Path(payload.file_path)
    session_norm_dir = settings.NORMALIZED_DIR / session_id
    session_norm_dir.mkdir(parents=True, exist_ok=True)
    out_pdf = session_norm_dir / f"{doc_id}.pdf"

    pages, is_locked, is_corrupt = normalize_any_document(src_file, out_pdf)

    session = active_sessions.get(session_id)
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

    print(f"\n[CORE] Processed: {doc_meta.original_filename} ({pages} pgs, {mode.value}) for {session.customer_phone}")
    print(f"[CORE] Total Batch Sheets: {session.total_sheets}")

    try:
        asyncio.run(ws_manager.broadcast_event("SESSION_UPDATED", session.model_dump()))
    except Exception as e:
        print(f"[WS] Broadcast notice: {e}")

    if auto_print_enabled and not is_corrupt and not is_locked:
        print(f"[AUTO-PRINT] Spooling session {session_id} immediately to {auto_print_target_printer or 'Default'}...")
        session.status = SessionStatus.SPOOLING

        manifest = [{
            "normalized_path": doc.normalized_path,
            "print_mode": doc.print_mode.value
        } for doc in session.documents]

        session_spool_dir = settings.SPOOL_DIR / session_id
        session_spool_dir.mkdir(parents=True, exist_ok=True)
        _, simplex_pdf, duplex_pdf, sheets = parity_engine.compile_session_batches(manifest, session_spool_dir)

        def auto_spool():
            spooler = get_spool_manager(printer_name=auto_print_target_printer or None)
            if simplex_pdf.exists() and pymupdf.open(simplex_pdf).page_count > 0:
                spooler.print_batch(simplex_pdf, duplex=False, tray_bin="Auto")
            if duplex_pdf.exists() and pymupdf.open(duplex_pdf).page_count > 0:
                spooler.print_batch(duplex_pdf, duplex=True, tray_bin="Auto")
            spooler.await_spool_completion(polling_timeout=settings.SPOOL_POLL_TIMEOUT_SECONDS)
            session.status = SessionStatus.COMPLETED
            print(f"[AUTO-PRINT] Completed print job for {session.customer_phone}")
            try:
                asyncio.run(ws_manager.broadcast_event("SESSION_UPDATED", session.model_dump()))
            except Exception:
                pass

        thread_pool.submit(auto_spool)

@app.websocket("/ws/operator")
async def operator_websocket(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        await websocket.send_json({
            "event": "INITIAL_SNAPSHOT",
            "payload": [s.model_dump() for s in active_sessions.values()],
            "gateway_state": gateway_state
        })
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)

# --- Gateway Pairing Endpoints ---
@app.get(f"{settings.API_V1_STR}/gateway/status")
async def get_gateway_status():
    """Returns current pairing state and active QR data URL for newly opened browsers."""
    return gateway_state

@app.post(f"{settings.API_V1_STR}/gateway/qr-state")
async def update_gateway_qr_state(payload: Dict[str, Any]):
    """Receives QR updates from Node.js sidecar and broadcasts to all browser screens."""
    global gateway_state
    gateway_state["status"] = payload.get("status", "DISCONNECTED")
    gateway_state["qr_image"] = payload.get("qr_image")
    gateway_state["updated_at"] = time.time()

    await ws_manager.broadcast_event("GATEWAY_STATUS_UPDATED", gateway_state)
    return {"status": "RELAYED"}

# --- Settings & Printer Endpoints ---
@app.get(f"{settings.API_V1_STR}/settings/auto-print")
async def get_auto_print_status():
    return {
        "auto_print": auto_print_enabled,
        "target_printer": auto_print_target_printer
    }

@app.post(f"{settings.API_V1_STR}/settings/auto-print")
async def toggle_auto_print(enabled: bool, target_printer: str = ""):
    global auto_print_enabled, auto_print_target_printer
    auto_print_enabled = enabled
    auto_print_target_printer = target_printer
    print(f"[SETTINGS] Auto-Print Mode: {'ENABLED' if enabled else 'DISABLED'} (Printer: {target_printer})")
    await ws_manager.broadcast_event("AUTO_PRINT_TOGGLED", {
        "auto_print": auto_print_enabled,
        "target_printer": auto_print_target_printer
    })
    return {"status": "UPDATED", "auto_print": auto_print_enabled}

@app.get(f"{settings.API_V1_STR}/printers")
async def get_system_printers():
    printers: List[str] = []
    default_printer = ""
    try:
        import win32print
        flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        for p in win32print.EnumPrinters(flags):
            printers.append(p[2])
        default_printer = win32print.GetDefaultPrinter()
    except Exception:
        printers = ["Default System Printer"]
        default_printer = printers[0]

    return {
        "printers": printers,
        "default": default_printer
    }

# --- Core Ingestion & Session Actions ---
@app.post(f"{settings.API_V1_STR}/queue/inbound-document", status_code=202)
async def ingest_inbound_document(payload: InboundDocumentPayload, bg: BackgroundTasks):
    now = time.time()
    phone = payload.customer_phone

    existing_session_id = phone_to_session_map.get(phone)
    if existing_session_id and existing_session_id in active_sessions:
        session = active_sessions[existing_session_id]
        if now - session.last_activity_at <= settings.SESSION_WINDOW_SECONDS:
            session.last_activity_at = now
            session_id = existing_session_id
        else:
            session_id = str(uuid.uuid4())
            active_sessions[session_id] = SessionState(
                session_id=session_id, customer_phone=phone, status=SessionStatus.RECEIVING, created_at=now, last_activity_at=now
            )
            phone_to_session_map[phone] = session_id
    else:
        session_id = str(uuid.uuid4())
        active_sessions[session_id] = SessionState(
            session_id=session_id, customer_phone=phone, status=SessionStatus.RECEIVING, created_at=now, last_activity_at=now
        )
        phone_to_session_map[phone] = session_id

    doc_id = str(uuid.uuid4())
    bg.add_task(process_normalization_background, session_id, payload, doc_id)
    return {"session_id": session_id, "document_id": doc_id, "status": "PROCESSING"}

@app.get(f"{settings.API_V1_STR}/sessions/{{session_id}}/download")
async def download_master_pdf(session_id: str):
    session = active_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Customer session not found.")

    if not session.documents:
        raise HTTPException(status_code=400, detail="No documents available in this batch.")

    manifest = []
    for doc in session.documents:
        p = Path(doc.normalized_path).resolve()
        if p.exists():
            manifest.append({
                "normalized_path": str(p),
                "print_mode": doc.print_mode.value
            })

    if not manifest:
        raise HTTPException(status_code=400, detail="Files are still undergoing A4 normalization. Please retry in 1 second.")

    try:
        pdf_bytes = parity_engine.generate_inspection_pdf_bytes(manifest)
        filename = f"PrintFlow_{session_id[:8]}.pdf"
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Content-Length": str(len(pdf_bytes)),
                "Access-Control-Expose-Headers": "Content-Disposition"
            }
        )
    except Exception as e:
        print(f"[ERROR] Master PDF compilation error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to generate Master PDF: {str(e)}")

@app.post(f"{settings.API_V1_STR}/sessions/{{session_id}}/complete")
async def complete_session(session_id: str):
    """Marks an order as completed/handed-over, updating active dashboard queues and scheduling 15m purge."""
    session = active_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Customer session not found.")

    session.status = SessionStatus.COMPLETED
    session.last_activity_at = time.time()
    try:
        await ws_manager.broadcast_event("SESSION_UPDATED", session.model_dump())
    except Exception:
        pass

    # Schedule 15-minute automatic disk purge (900 seconds)
    asyncio.create_task(schedule_delayed_purge(session_id, delay_seconds=900))
    return {"status": "SUCCESS", "session_id": session_id, "purge_in_seconds": 900}

@app.post(f"{settings.API_V1_STR}/sessions/clear-completed")
async def clear_all_completed_sessions():
    """Immediately flushes all completed sessions from memory and triggers a storage disk wipe."""
    completed_ids = [sid for sid, s in active_sessions.items() if s.status == SessionStatus.COMPLETED]
    for sid in completed_ids:
        session = active_sessions.pop(sid, None)
        if session and session.customer_phone in phone_to_session_map:
            if phone_to_session_map[session.customer_phone] == sid:
                del phone_to_session_map[session.customer_phone]
        try:
            await ws_manager.broadcast_event("SESSION_PURGED", {"session_id": sid})
        except Exception:
            pass

    cleaner_service.execute_purge_sweep()
    return {"status": "SUCCESS", "purged_count": len(completed_ids)}

@app.post(f"{settings.API_V1_STR}/sessions/{{session_id}}/dispatch")
async def dispatch_session(session_id: str, req: DispatchRequest, bg: BackgroundTasks):
    session = active_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    override_map = {o.document_id: o.print_mode for o in req.document_overrides}
    manifest = []
    for doc in session.documents:
        if doc.id in override_map:
            doc.print_mode = override_map[doc.id]
        manifest.append({
            "normalized_path": doc.normalized_path,
            "print_mode": doc.print_mode.value
        })

    session_spool_dir = settings.SPOOL_DIR / session_id
    session_spool_dir.mkdir(parents=True, exist_ok=True)
    _, simplex_pdf, duplex_pdf, sheets = parity_engine.compile_session_batches(manifest, session_spool_dir)
    session.total_sheets = sheets
    session.status = SessionStatus.SPOOLING

    def execute_print():
        spooler = get_spool_manager(printer_name=req.target_printer)
        if simplex_pdf.exists() and pymupdf.open(simplex_pdf).page_count > 0:
            spooler.print_batch(simplex_pdf, duplex=False, tray_bin=req.tray_bin)
        if duplex_pdf.exists() and pymupdf.open(duplex_pdf).page_count > 0:
            spooler.print_batch(duplex_pdf, duplex=True, tray_bin=req.tray_bin)
        spooler.await_spool_completion(polling_timeout=settings.SPOOL_POLL_TIMEOUT_SECONDS)
        session.status = SessionStatus.COMPLETED

    bg.add_task(execute_print)
    return {"status": "SPOOLING_DISPATCHED", "total_sheets": sheets}