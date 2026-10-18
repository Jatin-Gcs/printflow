import io
import math
from pathlib import Path
from typing import List, Dict, Any, Tuple
import pymupdf

class ParityQueueEngine:
    def __init__(self, paper_format: str = "a4"):
        self.a4_w, self.a4_h = pymupdf.paper_size(paper_format)

    def generate_inspection_pdf_bytes(self, manifest: List[Dict[str, Any]]) -> bytes:
        """
        Compiles the master inspection PDF completely in RAM to avoid Windows WinError 32 file locks.
        """
        inspect_doc = pymupdf.open()

        for item in manifest:
            doc_path = Path(item["normalized_path"]).resolve()
            if not doc_path.exists():
                continue

            src = pymupdf.open(doc_path)
            inspect_doc.insert_pdf(src)
            src.close()

        pdf_bytes = inspect_doc.tobytes(garbage=4, deflate=True)
        inspect_doc.close()
        return pdf_bytes

    def compile_session_batches(
        self,
        manifest: List[Dict[str, Any]],
        output_dir: Path
    ) -> Tuple[Path, Path, Path, int]:
        output_dir.mkdir(parents=True, exist_ok=True)

        inspect_doc = pymupdf.open()
        simplex_doc = pymupdf.open()
        duplex_doc = pymupdf.open()

        simplex_pages = 0
        duplex_pages = 0

        for item in manifest:
            doc_path = Path(item["normalized_path"]).resolve()
            if not doc_path.exists():
                continue

            is_duplex = (item.get("print_mode", "SIMPLEX").upper() == "DUPLEX")
            src = pymupdf.open(doc_path)
            page_count = src.page_count

            inspect_doc.insert_pdf(src)

            if is_duplex:
                duplex_doc.insert_pdf(src)
                duplex_pages += page_count

                if page_count % 2 != 0:
                    duplex_doc.new_page(pno=-1, width=self.a4_w, height=self.a4_h)
                    duplex_pages += 1
            else:
                simplex_doc.insert_pdf(src)
                simplex_pages += page_count

            src.close()

        inspect_pdf = output_dir / "session_inspect.pdf"
        simplex_pdf = output_dir / "batch_simplex.pdf"
        duplex_pdf = output_dir / "batch_duplex.pdf"

        inspect_doc.save(str(inspect_pdf), garbage=4, deflate=True)
        simplex_doc.save(str(simplex_pdf), garbage=4, deflate=True)
        duplex_doc.save(str(duplex_pdf), garbage=4, deflate=True)

        inspect_doc.close()
        simplex_doc.close()
        duplex_doc.close()

        total_physical_sheets = simplex_pages + math.ceil(duplex_pages / 2)
        return inspect_pdf, simplex_pdf, duplex_pdf, total_physical_sheets