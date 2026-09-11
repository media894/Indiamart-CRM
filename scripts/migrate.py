import json
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_FILE = BASE_DIR / "server" / "data.json"
SETTINGS_FILE = BASE_DIR / "server" / "settings.json"
MONGODB_URI = os.getenv("MONGODB_URI", "mongodb+srv://natasha_db_user:Socialmediaodd2026@mediaodd.wwilbgn.mongodb.net/indiamart_crm?retryWrites=true&w=majority")

def run_migration():
    print("Connecting to MongoDB...")
    try:
        from pymongo import MongoClient
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client.get_default_database()

        print("Reading local data...")
        local_data = {"leads": [], "emails": [], "followups": []}
        if DATA_FILE.exists():
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                local_data = json.load(f)

        cloud_doc = db.crm.find_one({"_id": "main"}) or {"leads": [], "emails": [], "followups": []}

        lead_map = {l["id"]: l for l in cloud_doc.get("leads", []) if "id" in l}
        for l in local_data.get("leads", []):
            if "id" in l:
                lead_map[l["id"]] = l
        merged_leads = list(lead_map.values())

        email_map = {e["id"]: e for e in cloud_doc.get("emails", []) if "id" in e}
        for e in local_data.get("emails", []):
            if "id" in e:
                email_map[e["id"]] = e
        merged_emails = list(email_map.values())

        followup_map = {f["id"]: f for f in cloud_doc.get("followups", []) if "id" in f}
        for f in local_data.get("followups", []):
            if "id" in f:
                followup_map[f["id"]] = f
        merged_followups = list(followup_map.values())

        db.crm.update_one(
            {"_id": "main"},
            {"$set": {"leads": merged_leads, "emails": merged_emails, "followups": merged_followups}},
            upsert=True
        )

        if SETTINGS_FILE.exists():
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                s = json.load(f)
            cloud_settings = db.settings.find_one({"_id": "main"})
            merged_settings = {**(cloud_settings.get("settings", {}) if cloud_settings else {}), **s}
            db.settings.update_one({"_id": "main"}, {"$set": {"settings": merged_settings}}, upsert=True)

        print("Migration complete! Data synced with MongoDB.")
        client.close()
    except Exception as e:
        print(f"Migration failed: {e}")

if __name__ == "__main__":
    run_migration()
