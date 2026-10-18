import os
import sys
from pathlib import Path
from pydantic import computed_field
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    PROJECT_NAME: str = "PrintFlow Core Engine"
    API_V1_STR: str = "/api/v1"

    # Base Storage Directory
    BASE_STORAGE_DIR: Path = (
        Path("C:/PrintShopManager/storage") if sys.platform == "win32"
        else Path(os.getenv("BASE_STORAGE_DIR", "../../storage")).resolve()
    )

    # Executable Paths
    SUMATRA_BIN_PATH: Path = (
        Path(r"C:\Program Files\SumatraPDF\SumatraPDF.exe") if sys.platform == "win32"
        else Path("/usr/bin/sumatrapdf")
    )

    SOFFICE_BIN_PATH: Path = (
        Path(r"C:\Program Files\LibreOffice\program\soffice.exe") if sys.platform == "win32"
        else Path("/usr/bin/soffice")
    )

    # Operational Windows & Timeouts
    SESSION_WINDOW_SECONDS: int = 120
    SESSION_TTL_SECONDS: int = 3600
    OFFICE_CONVERT_TIMEOUT_SECONDS: int = 45
    SPOOL_POLL_TIMEOUT_SECONDS: int = 60

    # Pricing Defaults
    DEFAULT_SIMPLEX_RATE: float = 2.00
    DEFAULT_DUPLEX_RATE: float = 3.00

    # Storage subdirectories defined with Pydantic computed_field
    @computed_field
    @property
    def INGRESS_DIR(self) -> Path:
        return self.BASE_STORAGE_DIR / "ingress"

    @computed_field
    @property
    def NORMALIZED_DIR(self) -> Path:
        return self.BASE_STORAGE_DIR / "normalized"

    @computed_field
    @property
    def SPOOL_DIR(self) -> Path:
        return self.BASE_STORAGE_DIR / "spool"

    @computed_field
    @property
    def QUARANTINE_DIR(self) -> Path:
        return self.BASE_STORAGE_DIR / "quarantine"

    def init_directories(self) -> None:
        """Ensures all working directories exist before jobs start."""
        for folder in [self.INGRESS_DIR, self.NORMALIZED_DIR, self.SPOOL_DIR, self.QUARANTINE_DIR]:
            folder.mkdir(parents=True, exist_ok=True)

    class Config:
        env_file = "../config.env"
        extra = "ignore"

settings = Settings()
settings.init_directories()