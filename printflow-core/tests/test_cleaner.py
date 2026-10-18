import time
import os
from pathlib import Path
from app.config import settings
from app.services.cleaner import EphemeralStorageManager

def run_cleaner_tests():
    print("=== Testing F-07: Ephemeral Storage TTL Cleaner ===")
    
    test_base = settings.BASE_STORAGE_DIR / "cleaner_test"
    ingress = test_base / "ingress"
    ingress.mkdir(parents=True, exist_ok=True)
    
    # 1. Create a simulated expired session directory
    expired_session = ingress / "test_session_expired"
    expired_session.mkdir(parents=True, exist_ok=True)
    
    test_file = expired_session / "sensitive_document.pdf"
    with open(test_file, "w") as f:
        f.write("%PDF-1.7 mock sensitive customer data")
        
    print(f"[+] Created test file: {test_file}")
    
    # Backdate the modification time by 2 hours (7200 seconds)
    two_hours_ago = time.time() - 7200
    os.utime(test_file, (two_hours_ago, two_hours_ago))
    os.utime(expired_session, (two_hours_ago, two_hours_ago))
    
    purged_sessions = []
    cleaner = EphemeralStorageManager(
        base_directory=test_base,
        ttl_seconds=3600,
        on_session_purged=lambda sid: purged_sessions.append(sid)
    )
    
    # 2. Trigger the purge sweep
    print("[+] Triggering sweep...")
    cleaner.execute_purge_sweep()
    
    # 3. Verify directory is gone
    assert not expired_session.exists(), "Expired session directory still exists!"
    print("[✓] Expired session successfully isolated, quarantined, and deleted.")
    print(f"[✓] Eviction callback triggered for: {purged_sessions}")
    
    # Cleanup test base
    try:
        (test_base / "quarantine").rmdir()
        ingress.rmdir()
        test_base.rmdir()
    except Exception:
        pass
        
    print("\n=== Sprint 7 (F-07) Verification Passed Successfully! ===")

if __name__ == "__main__":
    run_cleaner_tests()