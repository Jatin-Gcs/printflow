import os
import time
import uuid
import logging
from pathlib import Path
from typing import Callable, Optional
from apscheduler.schedulers.background import BackgroundScheduler

logger = logging.getLogger("RetentionManager")
logging.basicConfig(level=logging.INFO)

class EphemeralStorageManager:
    """
    Automated retention manager enforcing a strict TTL policy.
    Uses the Atomic Quarantine Rename pattern to prevent race conditions 
    and gracefully handles Windows WinError 32 file-locking contentions.
    """

    def __init__(
        self,
        base_directory: Path,
        ttl_seconds: int = 3600,
        on_session_purged: Optional[Callable[[str], None]] = None
    ):
        self.base_dir = Path(base_directory)
        self.ttl = ttl_seconds
        self.on_session_purged = on_session_purged
        self.scheduler = BackgroundScheduler()

    def start_retention_service(self) -> None:
        """Starts the background cron ticker (runs every 60 seconds)."""
        self.scheduler.add_job(
            self.execute_purge_sweep,
            "interval",
            seconds=60,
            id="ttl_purge_sweep",
            max_instances=1,
            coalesce=True
        )
        self.scheduler.start()
        logger.info(f"[CLEANER] Ephemeral TTL purge service active (TTL: {self.ttl}s, Sweep: 60s).")

    def execute_purge_sweep(self) -> None:
        """Executes a complete sweep across storage tiers."""
        current_time = time.time()
        quarantine_dir = self.base_dir / "quarantine"
        quarantine_dir.mkdir(parents=True, exist_ok=True)

        # Storage folders subject to ephemeral retention
        target_roots = [
            self.base_dir / "ingress",
            self.base_dir / "normalized",
            self.base_dir / "spool"
        ]

        for root in target_roots:
            if not root.exists():
                continue

            for session_dir in list(root.iterdir()):
                if not session_dir.is_dir() or session_dir.name.startswith("quarantine_"):
                    continue

                try:
                    dir_stat = session_dir.stat()
                    # Age check against directory modification timestamp
                    if current_time - dir_stat.st_mtime > self.ttl:
                        session_id = session_dir.name
                        quarantine_name = f"quarantine_{session_id}_{uuid.uuid4().hex[:6]}"
                        quarantine_path = quarantine_dir / quarantine_name

                        # Atomic rename isolates folder from any incoming writes
                        session_dir.rename(quarantine_path)
                        logger.info(f"[CLEANER] Session {session_id} expired. Moved to quarantine: {quarantine_name}")

                        # Attempt immediate unlink
                        self._safe_unlink_quarantine(quarantine_path)

                        # Trigger memory purge callback
                        if self.on_session_purged:
                            self.on_session_purged(session_id)

                except PermissionError:
                    logger.warning(f"[CLEANER] Directory {session_dir.name} in active use. Deferring to next sweep.")
                except Exception as ex:
                    logger.error(f"[CLEANER] Sweep error on {session_dir.name}: {ex}")

        # Sweep and retry any deferred quarantine folders
        if quarantine_dir.exists():
            for q_dir in list(quarantine_dir.iterdir()):
                if q_dir.is_dir():
                    self._safe_unlink_quarantine(q_dir)

    def _safe_unlink_quarantine(self, quarantine_path: Path) -> None:
        """Recursively removes quarantined files, gracefully surviving transient Windows locks."""
        all_cleared = True

        for root, dirs, files in os.walk(quarantine_path, topdown=False):
            for file_name in files:
                file_path = Path(root) / file_name
                try:
                    # Clear read-only attributes on Windows
                    file_path.chmod(0o777)
                    file_path.unlink()
                except PermissionError:
                    # Windows locked file (e.g., spooler or antivirus has open handle)
                    all_cleared = False
                except Exception as ex:
                    logger.error(f"[CLEANER] Could not unlink {file_path}: {ex}")
                    all_cleared = False

            for dir_name in dirs:
                subdir_path = Path(root) / dir_name
                try:
                    subdir_path.rmdir()
                except OSError:
                    all_cleared = False

        if all_cleared:
            try:
                quarantine_path.rmdir()
                logger.info(f"[CLEANER] Purged quarantine container: {quarantine_path.name}")
            except OSError:
                pass