import sys
from pathlib import Path
from PIL import Image as PILImage
import pymupdf

# Ensure app is discoverable
sys.path.append(str(Path(__file__).parent))

from app.services.normalization import normalize_any_document
from app.config import settings

def run_tests():
    print("=== Testing F-01: Document Normalization Engine ===")
    test_dir = settings.BASE_STORAGE_DIR / "test_samples"
    output_dir = settings.NORMALIZED_DIR / "test_run"
    test_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    # 1. Create a synthetic test image
    sample_img_path = test_dir / "sample_photo.jpg"
    img = PILImage.new("RGB", (1200, 1600), color=(70, 130, 180))
    img.save(sample_img_path, quality=90)
    print(f"[+] Created synthetic test image: {sample_img_path.name}")

    # 2. Normalize image to A4 PDF
    norm_img_pdf = output_dir / "sample_photo_normalized.pdf"
    pages, locked, corrupt = normalize_any_document(sample_img_path, norm_img_pdf)
    
    assert not corrupt, "Image normalization reported corrupted!"
    assert pages == 1, f"Expected 1 page, got {pages}"
    
    # Verify dimensions on the resulting PDF
    doc = pymupdf.open(norm_img_pdf)
    page = doc[0]
    rect = page.rect
    print(f"[✓] Image normalized successfully: {norm_img_pdf.name}")
    print(f"    Page Dimensions: {rect.width:.2f} x {rect.height:.2f} pt (Target A4: 595.00 x 842.00)")
    
    # PyMuPDF standard A4 integer points are 595 x 842
    assert abs(rect.width - 595.0) < 1.0 and abs(rect.height - 842.0) < 1.0, "Dimensions do not match A4!"
    doc.close()

    print("\n=== Sprint 1 (F-01) Verification Passed Successfully! ===")

if __name__ == "__main__":
    run_tests()