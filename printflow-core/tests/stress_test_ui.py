import time
import requests
from pathlib import Path

BASE_URL = "http://127.0.0.1:8000/api/v1/queue/inbound-document"

# Sample file paths on disk for testing
sample_pdf = Path("D:/Projects/printflow/storage/normalized/test_run/sample_photo_normalized.pdf").resolve()
if not sample_pdf.exists():
    # Fallback placeholder string
    sample_pdf = Path("D:/Projects/printflow/storage/test_dummy.pdf")

customers = [
    {
        "phone": "+91 98250 11223",
        "files": [
            ("aadhaar_card_both_sides.pdf", "application/pdf", 2),
            ("college_hall_ticket_2026.pdf", "application/pdf", 1)
        ]
    },
    {
        "phone": "+91 94280 44556",
        "files": [
            ("project_synopsis_final_v3_draft_reviewed.docx", "application/pdf", 7),
            ("architecture_diagram_high_res_render.png", "image/jpeg", 1),
            ("references_and_index_pages.pdf", "application/pdf", 3)
        ]
    },
    {
        "phone": "+91 70162 99887",
        "files": [
            ("passport_size_photo_grid.jpg", "image/jpeg", 1)
        ]
    },
    {
        "phone": "+91 99090 33445",
        "files": [
            ("court_affidavit_notarized_copy.pdf", "application/pdf", 4),
            ("electricity_bill_september.pdf", "application/pdf", 2),
            ("property_tax_receipt.pdf", "application/pdf", 1),
            ("identity_declaration_form.pdf", "application/pdf", 1)
        ]
    },
    {
        "phone": "+91 81400 77665",
        "files": [
            ("complete_ebook_algorithms_cormen_chapter_4.pdf", "application/pdf", 19)
        ]
    },
    {
        "phone": "+91 97230 55667",
        "files": [
            ("shipping_manifest_consignment_tracking_label_awb.pdf", "application/pdf", 2),
            ("gst_tax_invoice_signed.pdf", "application/pdf", 1)
        ]
    },
    {
        "phone": "+91 91060 22334",
        "files": [
            ("semester_5_gradecard_provisional.jpg", "image/jpeg", 1),
            ("internship_completion_certificate.pdf", "application/pdf", 1),
            ("recommendation_letter_hod.pdf", "application/pdf", 2)
        ]
    }
]

def run_stress_injection():
    print(f"[*] Dispatching {len(customers)} customer batches to {BASE_URL}...")
    
    total_docs = 0
    for idx, c in enumerate(customers):
        for f_idx, (fname, mtype, pcount) in enumerate(c["files"]):
            payload = {
                "customer_phone": c["phone"],
                "message_id": f"STRESS_MSG_{idx}_{f_idx}",
                "file_path": str(sample_pdf),
                "original_filename": fname,
                "mime_type": mtype,
                "file_size": 1024 * (f_idx + 1) * 32,
                "timestamp": time.time()
            }
            try:
                res = requests.post(BASE_URL, json=payload, timeout=5)
                if res.status_code == 202:
                    total_docs += 1
            except Exception as e:
                print(f"[!] Injection error: {e}")
        # Brief stagger between batches
        time.sleep(0.15)

    print(f"[✓] Completed injection of {total_docs} files across {len(customers)} customer sessions.")

if __name__ == "__main__":
    run_stress_injection()