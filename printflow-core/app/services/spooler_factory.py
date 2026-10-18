import sys
from pathlib import Path
from typing import Optional, Protocol, Any

class BaseSpooler(Protocol):
    def print_batch(self, file_path: Path, duplex: bool = False, tray_bin: Optional[str] = None) -> Any: ...
    def await_spool_completion(self, polling_timeout: int = 45) -> None: ...

class MockSpooler:
    """Mock spooler for environments without physical hardware or SumatraPDF binary."""
    def __init__(self, printer_name: Optional[str] = None):
        self.printer_name = printer_name or "Virtual_Mock_Printer"

    def print_batch(self, file_path: Path, duplex: bool = False, tray_bin: Optional[str] = None) -> None:
        print(f"    [MockSpooler] Dispatched: {file_path.name} | Duplex: {duplex} | Tray: {tray_bin}")

    def await_spool_completion(self, polling_timeout: int = 45) -> None:
        print("    [MockSpooler] Spool queue cleared successfully.")

def get_spool_manager(printer_name: Optional[str] = None, force_mock: bool = False) -> BaseSpooler:
    """
    Returns the Windows spooler if SumatraPDF and Windows APIs exist,
    otherwise provides the mock spooler for dev/dry-run environments.
    """
    if force_mock:
        return MockSpooler(printer_name=printer_name)

    if sys.platform == "win32":
        from app.services.spooler import WindowsSpoolManager
        from app.config import settings
        if settings.SUMATRA_BIN_PATH.exists():
            return WindowsSpoolManager(sumatra_binary=settings.SUMATRA_BIN_PATH, printer_name=printer_name)

    return MockSpooler(printer_name=printer_name)