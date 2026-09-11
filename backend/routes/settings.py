import shutil
from pathlib import Path
from fastapi import APIRouter, HTTPException, UploadFile, File
from backend.config import load_settings_dict, save_settings_dict, ASSETS_DIR
from backend.services.indiamart_sync import execute_indiamart_sync

router = APIRouter(prefix="/api", tags=["Settings"])

@router.get("/settings")
def get_settings():
    return load_settings_dict()

@router.post("/settings")
def save_settings(settings_data: dict):
    current = load_settings_dict()
    current.update(settings_data)
    save_settings_dict(current)
    return {"ok": True, "settings": current}

@router.post("/upload")
def upload_file(file: UploadFile = File(...)):
    if not file:
        raise HTTPException(status_code=400, detail="No file provided")

    ext = Path(file.filename).suffix.lower()
    filename = f"signature{ext}" if "signature" in file.filename.lower() else f"brochure{ext}"
    dest_path = ASSETS_DIR / filename

    with open(dest_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return {"ok": True, "path": f"/assets/{filename}", "name": filename}

@router.post("/upload-price-sheet")
def upload_price_sheet(file: UploadFile = File(...)):
    if not file:
        raise HTTPException(status_code=400, detail="No price sheet file provided")

    ext = Path(file.filename).suffix.lower()
    if ext not in [".xlsx", ".xls", ".json", ".csv"]:
        raise HTTPException(status_code=400, detail="File must be an Excel (.xlsx) or JSON (.json) or CSV (.csv) file")

    server_dir = Path(__file__).resolve().parent.parent.parent / "server"
    server_dir.mkdir(parents=True, exist_ok=True)
    dest_path = server_dir / f"price_sheet{ext}"

    with open(dest_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return {"ok": True, "message": f"Price sheet saved successfully as price_sheet{ext}", "filename": f"price_sheet{ext}"}

@router.post("/automation/{mode}")
def toggle_automation(mode: str):
    if mode not in ["on", "off"]:
        raise HTTPException(status_code=400, detail="Mode must be on or off")

    enabled = (mode == "on")
    current = load_settings_dict()
    current["indiamartSyncEnabled"] = enabled
    current["autoResponseEnabled"] = enabled
    save_settings_dict(current)

    if enabled:
        try:
            execute_indiamart_sync(current)
        except Exception as e:
            print(f"[Automation Toggle] Sync error: {e}")

    return {"ok": True, "enabled": enabled, "settings": current}
