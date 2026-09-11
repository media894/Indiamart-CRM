import json
from pathlib import Path
from typing import Dict, Any, List
import pandas as pd

BASE_DIR = Path(__file__).resolve().parent.parent.parent
SERVER_DIR = BASE_DIR / "server"
PRICE_SHEET_JSON = SERVER_DIR / "price_sheet.json"
PRICE_SHEET_EXCEL = SERVER_DIR / "price_sheet.xlsx"

DEFAULT_PRICING = {
    "tshirtprinting": {
        "title": "T-Shirt Printing Services",
        "unit": "piece",
        "tiers": [
            {"min_qty": 1, "max_qty": 49, "rate": 220},
            {"min_qty": 50, "max_qty": 199, "rate": 180},
            {"min_qty": 200, "max_qty": 9999, "rate": 150}
        ]
    },
    "tshirtembroidery": {
        "title": "T-Shirt Embroidery Services",
        "unit": "piece",
        "tiers": [
            {"min_qty": 1, "max_qty": 49, "rate": 250},
            {"min_qty": 50, "max_qty": 199, "rate": 210},
            {"min_qty": 200, "max_qty": 9999, "rate": 170}
        ]
    },
    "logo": {
        "title": "Logo Design Services",
        "unit": "design",
        "fixed_price": 2500
    },
    "graphic": {
        "title": "Graphic Design Services",
        "unit": "design",
        "fixed_price": 1500
    },
    "vector": {
        "title": "Vector Artwork & Redraw Services",
        "unit": "file",
        "fixed_price": 600
    },
    "imageediting": {
        "title": "Image Editing Services",
        "unit": "image",
        "tiers": [
            {"min_qty": 1, "max_qty": 49, "rate": 45},
            {"min_qty": 50, "max_qty": 199, "rate": 35},
            {"min_qty": 200, "max_qty": 9999, "rate": 25}
        ]
    }
}

def save_pricing_matrix(matrix: Dict[str, Any]) -> bool:
    try:
        SERVER_DIR.mkdir(parents=True, exist_ok=True)
        with open(PRICE_SHEET_JSON, "w", encoding="utf-8") as f:
            json.dump(matrix, f, indent=2)
        return True
    except Exception as e:
        print(f"[QuoteEngine] Error saving pricing matrix: {e}")
        return False

def parse_excel_or_csv(file_path: Path) -> Dict[str, Any]:
    try:
        if file_path.suffix.lower() == ".csv":
            df = pd.read_csv(file_path)
        else:
            df = pd.read_excel(file_path)
        
        matrix = {}
        for _, row in df.iterrows():
            service = str(row.get("Service", "")).strip().lower().replace(" ", "")
            title = str(row.get("Title") or row.get("Service", "")).strip()
            unit = str(row.get("Unit", "piece")).strip()
            
            if not service:
                continue

            rate = row.get("Rate") or row.get("Price")
            tier1 = row.get("Tier1_Rate") or row.get("Rate_1_49")
            tier2 = row.get("Tier2_Rate") or row.get("Rate_50_199")
            tier3 = row.get("Tier3_Rate") or row.get("Rate_200_plus")

            if pd.notna(tier1) and pd.notna(tier2):
                matrix[service] = {
                    "title": title or service.capitalize(),
                    "unit": unit,
                    "tiers": [
                        {"min_qty": 1, "max_qty": 49, "rate": float(tier1)},
                        {"min_qty": 50, "max_qty": 199, "rate": float(tier2)},
                        {"min_qty": 200, "max_qty": 9999, "rate": float(tier3 if pd.notna(tier3) else tier2)}
                    ]
                }
            elif pd.notna(rate):
                matrix[service] = {
                    "title": title or service.capitalize(),
                    "unit": unit,
                    "fixed_price": float(rate)
                }
        if matrix:
            save_pricing_matrix(matrix)
            return matrix
    except Exception as e:
        print(f"[QuoteEngine] Error parsing Excel/CSV: {e}")
    return load_pricing_matrix()

def load_pricing_matrix() -> Dict[str, Any]:
    if PRICE_SHEET_JSON.exists():
        try:
            with open(PRICE_SHEET_JSON, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass

    if PRICE_SHEET_EXCEL.exists():
        return parse_excel_or_csv(PRICE_SHEET_EXCEL)

    return DEFAULT_PRICING


def calculate_quote(service_key: str, quantity: int = 1) -> Dict[str, Any]:
    matrix = load_pricing_matrix()
    service_key = service_key.lower().strip()
    
    pricing = matrix.get(service_key) or matrix.get("graphic")
    unit = pricing.get("unit", "item")
    title = pricing.get("title", "Services")

    rate = 0
    if "fixed_price" in pricing:
        rate = pricing["fixed_price"]
    elif "tiers" in pricing:
        qty = max(1, quantity)
        for tier in pricing["tiers"]:
            if tier["min_qty"] <= qty <= tier["max_qty"]:
                rate = tier["rate"]
                break
        if rate == 0 and pricing["tiers"]:
            rate = pricing["tiers"][-1]["rate"]

    total_amount = round(rate * quantity, 2)
    return {
        "service_key": service_key,
        "title": title,
        "quantity": quantity,
        "unit": unit,
        "unit_rate": rate,
        "total_amount": total_amount,
        "formatted_quote": f"{title}: {quantity} {unit}(s) @ ₹{rate}/{unit} = ₹{total_amount}"
    }
