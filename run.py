#!/usr/bin/env python3
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))

import uvicorn

if __name__ == "__main__":
    print("Chat IA en http://127.0.0.1:8765")
    uvicorn.run("app.main:app", host="127.0.0.1", port=8765, reload=False)
