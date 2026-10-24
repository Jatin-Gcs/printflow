from enum import Enum
from typing import List, Optional
from pydantic import BaseModel, Field

class PrintMode(str, Enum):
    SIMPLEX = "SIMPLEX"
    DUPLEX = "DUPLEX"

class SessionStatus(str, Enum):
    RECEIVING = "RECEIVING"
    READY = "READY"
    SPOOLING = "SPOOLING"
    COMPLETED = "COMPLETED"
    PURGED = "PURGED"

class InboundDocumentPayload(BaseModel):
    shop_id: str = "default"
    customer_phone: str
    message_id: str
    file_path: str
    original_filename: str
    mime_type: str
    file_size: int = 0
    timestamp: float

class DocumentMetadata(BaseModel):
    id: str
    original_filename: str
    normalized_path: str
    page_count: int
    print_mode: PrintMode
    copies: int = 1
    is_encrypted: bool = False
    is_corrupted: bool = False

class SessionState(BaseModel):
    session_id: str
    customer_phone: str
    status: SessionStatus
    documents: List[DocumentMetadata] = []
    created_at: float
    last_activity_at: float
    total_sheets: int = 0

class DocumentOverride(BaseModel):
    document_id: str
    print_mode: PrintMode

class DispatchRequest(BaseModel):
    action: str = Field(..., pattern="^(PRINT_DIRECT|DOWNLOAD_MASTER)$")
    target_printer: Optional[str] = None
    tray_bin: Optional[str] = None
    document_overrides: List[DocumentOverride] = []