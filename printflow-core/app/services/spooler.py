import subprocess
import time
from pathlib import Path
from typing import Optional

class WindowsSpoolManager:
    """
    Dispatches direct, zero-dialog print jobs using SumatraPDF CLI
    and monitors Windows Spooler queue health via win32print.
    """

    def __init__(self, sumatra_binary: Path, printer_name: Optional[str] = None):
        self.sumatra_binary = Path(sumatra_binary)
        self.printer_name = printer_name

        try:
            import win32print
            self.win32print = win32print
            if not self.printer_name:
                self.printer_name = self.win32print.GetDefaultPrinter()
        except ImportError:
            self.win32print = None

    def print_batch(
        self,
        file_path: Path,
        duplex: bool = False,
        tray_bin: Optional[str] = None
    ) -> None:
        """
        Dispatches a PDF file directly to the Windows printer driver without
        invoking any interactive GUI print dialogue.
        """
        file_path = Path(file_path).resolve()
        if not file_path.exists():
            raise FileNotFoundError(f"Spool candidate missing: {file_path}")

        # Assemble SumatraPDF silent print arguments
        settings = ["fit", "ignore-pdf-print-settings"]
        settings.append("duplexlong" if duplex else "simplex")
        if tray_bin and tray_bin.lower() != "auto":
            settings.append(f"bin={tray_bin}")

        command = [
            str(self.sumatra_binary),
            "-print-to", str(self.printer_name),
            "-silent",
            "-print-settings", ",".join(settings),
            str(file_path)
        ]

        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=60,
            check=False
        )

        if result.returncode != 0:
            raise RuntimeError(
                f"SumatraPDF failed with exit code {result.returncode}. Log: {result.stderr}"
            )

    def await_spool_completion(self, polling_timeout: int = 45) -> None:
        """
        Polls the Windows print spooler subsystem to confirm jobs leave the queue
        cleanly and catches hardware-level faults (paper out, offline, jam).
        """
        if not self.win32print or not self.printer_name:
            return

        printer_handle = self.win32print.OpenPrinter(self.printer_name)
        start_time = time.time()
        try:
            while time.time() - start_time < polling_timeout:
                jobs = self.win32print.EnumJobs(printer_handle, 0, -1, 2)
                if not jobs:
                    return  # Queue is clear; printer accepted the job buffer

                for job in jobs:
                    status = job["Status"]
                    if status & self.win32print.JOB_STATUS_ERROR:
                        raise IOError(f"Spooler error detected on Job ID {job['JobId']}")
                    if status & self.win32print.JOB_STATUS_OFFLINE:
                        raise IOError(f"Printer '{self.printer_name}' is offline.")
                    if status & self.win32print.JOB_STATUS_PAPEROUT:
                        raise IOError(f"Printer '{self.printer_name}' is out of paper.")

                time.sleep(0.8)
            raise TimeoutError("Print jobs remained in spooler queue past polling limit.")
        finally:
            self.win32print.ClosePrinter(printer_handle)