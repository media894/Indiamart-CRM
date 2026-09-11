import json
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_FILE = BASE_DIR / "server" / "data.json"
MONGODB_URI = os.getenv("MONGODB_URI", "mongodb+srv://natasha_db_user:Socialmediaodd2026@mediaodd.wwilbgn.mongodb.net/indiamart_crm?retryWrites=true&w=majority")

def fix_lead_types():
    if not DATA_FILE.exists():
        print("data.json not found.")
        return

    with open(DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    bl_count = 0
    w_count = 0

    updated_leads = []
    for l in data.get("leads", []):
        msg = str(l.get("message") or "").lower()
        q_type = l.get("queryType", "")
        is_buy_lead = (q_type in ["BL", "B"]) or ("requirement for" in msg) or ("buyer searched for" in msg) or ("buy lead" in msg)

        query_type = "BL" if is_buy_lead else "W"
        if query_type == "BL":
            bl_count += 1
        else:
            w_count += 1

        l["queryType"] = query_type
        updated_leads.append(l)

    data["leads"] = updated_leads
    print(f"Updated lead categorization -> Buy Leads (BL): {bl_count}, Direct Enquiries (W): {w_count}")

    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    print("✓ Successfully updated server/data.json")

    try:
        from pymongo import MongoClient
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client.get_default_database()
        db.crm.update_one(
            {"_id": "main"},
            {"$set": {"leads": data.get("leads", []), "emails": data.get("emails", []), "followups": data.get("followups", [])}},
            upsert=True
        )
        print("✓ Successfully updated crm collection in MongoDB!")
        client.close()
    except Exception as e:
        print(f"Error updating MongoDB: {e}")

if __name__ == "__main__":
    fix_lead_types()
