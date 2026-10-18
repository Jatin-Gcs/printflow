import sys
from pathlib import Path
import pymupdf

# Make app discoverable
sys.path.append(str(Path(__file__).parent))

from app.services.parity_engine import ParityQueueEngine
from app.config import settings

def create_dummy_pdf(output_path: Path, page_count: int, title: str):
    doc = pymupdf.open()
    a4_w, a4_h = pymupdf.paper_size("a4")
    for i in range(page_count):
        page = doc.new_page(width=a4_w, height=a4_h)
        page.insert_text((72, 100), f"{title} - Page {i + 1} of {page_count}", fontsize=20)
    doc.save(str(output_path))
    doc.close()

def run_parity_tests():
    print("=== Testing F-02: Duplex Parity & Odd-Page Padding Engine ===")
    test_dir = settings.BASE_STORAGE_DIR / "parity_test_samples"
    out_dir = settings.SPOOL_DIR / "parity_test_run"
    test_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1. Create synthetic documents with known page counts
    doc_a = test_dir / "doc_a_3pages.pdf"
    doc_b = test_dir / "doc_b_2pages.pdf"
    doc_c = test_dir / "doc_c_1page.pdf"

    create_dummy_pdf(doc_a, 3, "Doc A (3 pages)")  # Odd
    create_dummy_pdf(doc_b, 2, "Doc B (2 pages)")  # Even
    create_dummy_pdf(doc_c, 1, "Doc C (1 page)")   # Odd

    # 2. Manifest:
    # Doc A -> DUPLEX (3 pages -> needs 1 blank pad -> 4 pages)
    # Doc B -> DUPLEX (2 pages -> needs 0 pads -> 2 pages)
    # Total Duplex Pages = 6 pages (3 physical sheets)
    # Doc C -> SIMPLEX (1 page -> 1 physical sheet)
    # Expected Grand Total Physical Sheets = 4 sheets
    manifest = [
        {"normalized_path": str(doc_a), "print_mode": "DUPLEX"},
        {"normalized_path": str(doc_b), "print_mode": "DUPLEX"},
        {"normalized_path": str(doc_c), "print_mode": "SIMPLEX"},
    ]

    engine = ParityQueueEngine()
    inspect_pdf, simplex_pdf, duplex_pdf, total_sheets = engine.compile_session_batches(manifest, out_dir)

    # 3. Assertions
    # Check Simplex
    sim_doc = pymupdf.open(simplex_pdf)
    print(f"[✓] Simplex Batch generated: {sim_doc.page_count} page(s) (Expected: 1)")
    assert sim_doc.page_count == 1, f"Expected 1 simplex page, got {sim_doc.page_count}"
    sim_doc.close()

    # Check Duplex (3 + 1 pad + 2 = 6 pages)
    dup_doc = pymupdf.open(duplex_pdf)
    print(f"[✓] Duplex Batch generated: {dup_doc.page_count} page(s) (Expected: 6)")
    assert dup_doc.page_count == 6, f"Expected 6 duplex pages, got {dup_doc.page_count}"
    
    # Verify Page 4 in the duplex document is blank (it's our injected pad)
    page_4 = dup_doc[3]
    text_on_pad = page_4.get_text().strip()
    print(f"[✓] Injected Pad Page 4 content: '{text_on_pad}' (Expected empty string)")
    assert text_on_pad == "", "Injected pad page should be completely blank!"
    dup_doc.close()

    # Check Total Calculated Sheets
    print(f"[✓] Total Physical Sheets calculated: {total_sheets} (Expected: 4)")
    assert total_sheets == 4, f"Expected 4 physical sheets, got {total_sheets}"

    print("\n=== Sprint 2 (F-02) Verification Passed Successfully! ===")

if __name__ == "__main__":
    run_parity_tests()