import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Tuple
from PIL import Image as PILImage, ImageOps
import pymupdf
from app.config import settings

def normalize_raster_to_a4(source_image_path: Path, output_pdf_path: Path) -> int:
    """
    Standardizes arbitrary raster images into centered, aspect-preserved A4 vector PDF wrappers.
    Maintains 36pt (0.5 inch) mechanical gripper margins and embeds images directly via /XObject.
    """
    if not source_image_path.exists():
        raise FileNotFoundError(f"Source image missing: {source_image_path}")

    # 1. Correct image orientation based on camera EXIF tags
    with PILImage.open(source_image_path) as img:
        transposed_img = ImageOps.exif_transpose(img)
        img_w, img_h = transposed_img.size

    # 2. ISO 216 A4 Dimensions: 595.28 x 841.89 points
    a4_w, a4_h = pymupdf.paper_size("a4")
    margin = 36.0  # 0.5-inch margins
    printable_w = a4_w - (2 * margin)
    printable_h = a4_h - (2 * margin)

    # 3. Geometric uniform aspect-scaling computation: S = min(W_target / W_img, H_target / H_img)
    scale = min(printable_w / img_w, printable_h / img_h)
    render_w = img_w * scale
    render_h = img_h * scale

    # Centering offsets on page canvas
    x0 = (a4_w - render_w) / 2.0
    y0 = (a4_h - render_h) / 2.0
    target_rect = pymupdf.Rect(x0, y0, x0 + render_w, y0 + render_h)

    # 4. Generate standardized single-page PDF wrapper
    doc = pymupdf.open()
    page = doc.new_page(width=a4_w, height=a4_h)
    page.insert_image(target_rect, filename=str(source_image_path), keep_proportion=True)

    doc.save(str(output_pdf_path), garbage=4, deflate=True)
    doc.close()
    return 1

def convert_office_to_pdf(source_office_path: Path, output_dir: Path) -> Path:
    """
    Converts DOCX/ODT files to PDF using process-isolated headless LibreOffice.
    Avoids profile lock contentions (exit code 1) by pointing -env:UserInstallation to an isolated temp URI.
    """
    if not source_office_path.exists():
        raise FileNotFoundError(f"Source office file missing: {source_office_path}")

    instance_id = uuid.uuid4().hex
    temp_profile_dir = Path(tempfile.gettempdir()) / f"lo_profile_{instance_id}"
    temp_profile_uri = temp_profile_dir.as_uri()

    command = [
        str(settings.SOFFICE_BIN_PATH),
        "--headless",
        "--invisible",
        "--nocrashreport",
        "--nodefault",
        "--nofirststartwizard",
        "--nologo",
        "--norestore",
        f"-env:UserInstallation={temp_profile_uri}",
        "--convert-to", "pdf:writer_pdf_Export",
        "--outdir", str(output_dir),
        str(source_office_path)
    ]

    try:
        subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=settings.OFFICE_CONVERT_TIMEOUT_SECONDS,
            check=True
        )
        expected_output = output_dir / f"{source_office_path.stem}.pdf"
        if not expected_output.exists():
            raise FileNotFoundError(f"LibreOffice failed to generate expected artifact: {expected_output}")
        return expected_output
    finally:
        if temp_profile_dir.exists():
            shutil.rmtree(temp_profile_dir, ignore_errors=True)

def normalize_pdf_document(source_pdf_path: Path, output_pdf_path: Path) -> Tuple[int, bool]:
    """Validates, repairs, and standardizes an inbound PDF."""
    doc = pymupdf.open(source_pdf_path)

    if doc.is_encrypted:
        if not doc.authenticate(""):
            doc.close()
            return 0, True

    page_count = doc.page_count
    doc.save(str(output_pdf_path), garbage=4, deflate=True)
    doc.close()
    return page_count, False

def normalize_any_document(source_path: Path, output_pdf_path: Path) -> Tuple[int, bool, bool]:
    """Unified entry point for document normalization."""
    ext = source_path.suffix.lower()
    try:
        if ext in [".jpg", ".jpeg", ".png", ".webp", ".tiff", ".bmp"]:
            pages = normalize_raster_to_a4(source_path, output_pdf_path)
            return pages, False, False

        elif ext in [".docx", ".doc", ".odt", ".rtf"]:
            temp_output_dir = output_pdf_path.parent
            intermediate_pdf = convert_office_to_pdf(source_path, temp_output_dir)
            if intermediate_pdf != output_pdf_path:
                shutil.move(str(intermediate_pdf), str(output_pdf_path))
            d = pymupdf.open(output_pdf_path)
            pages = d.page_count
            d.close()
            return pages, False, False

        elif ext == ".pdf":
            pages, is_locked = normalize_pdf_document(source_path, output_pdf_path)
            if is_locked:
                return 0, True, False
            return pages, False, False

        else:
            return 0, False, True

    except Exception:
        return 0, False, True