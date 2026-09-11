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

@router.get("/pricing")
def get_pricing():
    from backend.services.quote_engine import load_pricing_matrix
    return load_pricing_matrix()

@router.post("/pricing")
def update_pricing(matrix: dict):
    from backend.services.quote_engine import save_pricing_matrix
    success = save_pricing_matrix(matrix)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to save pricing matrix")
    return {"ok": True, "message": "Pricing matrix updated successfully", "matrix": matrix}

@router.get("/sample-price-sheet")
def get_sample_price_sheet():
    from fastapi.responses import Response
    csv_content = (
        "Service,Title,Unit,Rate,Tier1_Rate,Tier2_Rate,Tier3_Rate\n"
        "tshirtprinting,T-Shirt Printing Services,piece,,220,180,150\n"
        "tshirtembroidery,T-Shirt Embroidery Services,piece,,250,210,170\n"
        "logo,Logo Design Services,design,2500,,,\n"
        "graphic,Graphic Design Services,design,1500,,,\n"
        "vector,Vector Artwork Redraw,file,600,,,\n"
        "imageediting,Image Editing Services,image,,45,35,25\n"
    )
    return Response(
        content=csv_content,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=sample_price_sheet.csv"}
    )

@router.post("/upload-price-sheet")
def upload_price_sheet(file: UploadFile = File(...)):
    if not file:
        raise HTTPException(status_code=400, detail="No price sheet file provided")

    ext = Path(file.filename).suffix.lower()
    if ext not in [".xlsx", ".xls", ".json", ".csv"]:
        raise HTTPException(status_code=400, detail="File must be an Excel (.xlsx/.xls), CSV (.csv), or JSON (.json) file")

    server_dir = Path(__file__).resolve().parent.parent.parent / "server"
    server_dir.mkdir(parents=True, exist_ok=True)
    dest_path = server_dir / f"price_sheet{ext}"

    with open(dest_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    from backend.services.quote_engine import parse_excel_or_csv, load_pricing_matrix
    if ext in [".xlsx", ".xls", ".csv"]:
        matrix = parse_excel_or_csv(dest_path)
    else:
        matrix = load_pricing_matrix()

    return {
        "ok": True,
        "message": f"Price sheet uploaded and parsed successfully as price_sheet{ext}",
        "matrix": matrix
    }


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
