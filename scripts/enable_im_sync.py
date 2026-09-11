import json
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
SETTINGS_FILE = BASE_DIR / "server" / "settings.json"
MONGODB_URI = os.getenv("MONGODB_URI", "mongodb+srv://natasha_db_user:Socialmediaodd2026@mediaodd.wwilbgn.mongodb.net/indiamart_crm?retryWrites=true&w=majority")

def enable_sync():
    settings = {}
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                settings = json.load(f)
        except Exception:
            settings = {}

    settings["indiamartSyncEnabled"] = True
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)
    print("✓ Enabled in server/settings.json")

    try:
        from pymongo import MongoClient
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client.get_default_database()
        doc = db.settings.find_one({"_id": "main"})
        db_settings = doc.get("settings", {}) if doc else {}
        db_settings["indiamartSyncEnabled"] = True
        db.settings.update_one({"_id": "main"}, {"$set": {"settings": db_settings}}, upsert=True)
        print("✓ Enabled in MongoDB settings collection")
        client.close()
    except Exception as e:
        print(f"⚠️ Could not update MongoDB: {e}")

if __name__ == "__main__":
    enable_sync()
