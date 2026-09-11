import os
import csv
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
MONGODB_URI = os.getenv("MONGODB_URI")

def export_leads():
    if not MONGODB_URI:
        print("MONGODB_URI is not set in .env file")
        return

    try:
        from pymongo import MongoClient
        print("Connecting to MongoDB...")
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client.get_default_database()
        doc = db.crm.find_one({"_id": "main"})

        if not doc or "leads" not in doc or not doc["leads"]:
            print("No leads found in the database.")
            return

        leads = doc["leads"]
        print(f"Found {len(leads)} leads. Generating CSV...")

        file_path = BASE_DIR / "leads_backup.csv"
        headers = ["Name", "Company", "Mobile", "Email", "Requirement", "Location", "Date"]

        with open(file_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(headers)
            for lead in leads:
                writer.writerow([
                    lead.get("SENDER_NAME") or lead.get("sender_name") or lead.get("name", ""),
                    lead.get("SENDER_COMPANY") or lead.get("sender_company") or lead.get("company", ""),
                    lead.get("SENDER_MOBILE") or lead.get("sender_mobile") or lead.get("phone", ""),
                    lead.get("SENDER_EMAIL") or lead.get("sender_email") or lead.get("email", ""),
                    lead.get("SUBJECT") or lead.get("subject") or lead.get("product") or lead.get("message", ""),
                    lead.get("SENDER_CITY") or lead.get("sender_city") or lead.get("city", ""),
                    lead.get("QUERY_TIME") or lead.get("query_time") or lead.get("createdAt", "")
                ])

        print(f"\nSUCCESS! 🎉")
        print(f"Your leads have been saved to: {file_path}")
        client.close()
    except Exception as e:
        print(f"Error exporting leads: {e}")

if __name__ == "__main__":
    export_leads()
