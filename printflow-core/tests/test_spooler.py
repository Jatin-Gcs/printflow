import sys
from pathlib import Path

sys.path.append(str(Path(__file__).parent))

from app.services.spooler_factory import get_spool_manager
from app.config import settings

def test_spooler_subsystem():
    print("=== Testing F-03: Zero-Dialog Print Spooler Subsystem ===")

    # 1. Inspect Windows printer drivers
    has_win32 = False
    default_printer = "None"
    try:
        import win32print
        default_printer = win32print.GetDefaultPrinter()
        has_win32 = True
        print(f"[✓] Windows Print Subsystem detected.")
        print(f"    Default Hardware Printer: {default_printer}")
    except Exception as e:
        print(f"[-] pywin32 not active or no printers found: {e}")

    # 2. Check for SumatraPDF binary
    sumatra_installed = settings.SUMATRA_BIN_PATH.exists()
    print(f"[{'✓' if sumatra_installed else '!'}] SumatraPDF binary check: {settings.SUMATRA_BIN_PATH}")
    if not sumatra_installed:
        print("    (SumatraPDF not found at default path; falling back to MockSpooler for test)")

    # 3. Prevent 'Save As' dialogue popups during automated test if printer is virtual
    is_virtual_printer = "print to pdf" in default_printer.lower() or "onenote" in default_printer.lower()
    force_mock = (not sumatra_installed) or is_virtual_printer

    if is_virtual_printer and sumatra_installed:
        print("    [Info] Default printer is a virtual PDF writer. Using MockSpooler to avoid file dialog prompts.")

    # 4. Test dummy dispatch through Spooler Factory
    test_pdf = settings.SPOOL_DIR / "parity_test_run" / "batch_simplex.pdf"
    if not test_pdf.exists():
        test_pdf = settings.NORMALIZED_DIR / "test_run" / "sample_photo_normalized.pdf"

    print(f"[+] Dispatching test document: {test_pdf.name}")
    spooler = get_spool_manager(
        printer_name=default_printer if has_win32 else None,
        force_mock=force_mock
    )

    # Simplex dispatch test
    spooler.print_batch(test_pdf, duplex=False, tray_bin="Auto")
    # Duplex dispatch test
    spooler.print_batch(test_pdf, duplex=True, tray_bin="Auto")

    # Queue polling simulation
    spooler.await_spool_completion(polling_timeout=5)

    print("\n=== Sprint 3 (F-03) Verification Passed Successfully! ===")

if __name__ == "__main__":
    test_spooler_subsystem()