import json
import re
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, List
from backend.config import DATA_FILE, MONGODB_URI

db_client = None
mongo_db = None

def connect_mongo():
    global db_client, mongo_db
    if MONGODB_URI:
        try:
            from pymongo import MongoClient
            db_client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
            mongo_db = db_client.get_default_database()
            print("Connected to MongoDB")
        except Exception as e:
            print(f"Failed to connect to MongoDB: {e}")
            print("Falling back to local JSON data file mode (data.json)")
            mongo_db = None

def normalize_email(email: str) -> str:
    if not email:
        return ""
    s = str(email).strip().lower()
    match = re.search(r'<([^>]+)>', s)
    if match:
        return match.group(1).strip().lower()
    return s

def parse_lead_name_from_body(body: str, to: str) -> str:
    match = re.search(r'\b(?:Dear|Hi)\s+([^,\n]+)', str(body or ""), re.IGNORECASE)
    if match and match.group(1):
        return match.group(1).strip()
    return get_name_from_email(to)

def parse_product_from_subject(subject: str) -> str:
    match = re.search(r'^Proposal for\s+(.+?)\s+\|\s+ODD INFOTECH', str(subject or ""), re.IGNORECASE)
    return match.group(1).strip() if match and match.group(1) else ""

def get_name_from_email(email: str) -> str:
    if not email or "@" not in email:
        return "Sir/Madam"
    parts = email.split("@")
    if len(parts) != 2:
        return "Sir/Madam"
    username = parts[0]
    username = re.sub(r'[._\-+]', ' ', username)
    username = re.sub(r'\d+', '', username).strip()
    if not username:
        return "Sir/Madam"
    return " ".join([word.capitalize() for word in username.split() if word]).strip() or "Sir/Madam"

def reconcile_email_lead_links(data: dict) -> bool:
    if "leads" not in data or not isinstance(data["leads"], list):
        data["leads"] = []
    if "emails" not in data or not isinstance(data["emails"], list):
        data["emails"] = []

    changed = False
    leads_by_id = {l["id"]: l for l in data["leads"] if "id" in l}
    leads_by_email = {normalize_email(l["email"]): l for l in data["leads"] if l.get("email")}

    for email in data["emails"]:
        if email.get("leadId") and email["leadId"] in leads_by_id:
            continue

        email_key = normalize_email(email.get("to"))
        matching_lead = leads_by_email.get(email_key) if email_key else None
        if matching_lead:
            email["leadId"] = matching_lead["id"]
            changed = True
            continue

        if email.get("direction") != "sent" or not email.get("autoResponse") or not email.get("to"):
            continue

        snapshot = email.get("leadSnapshot", {})
        restored_lead = {
            "id": email.get("leadId") or (datetime.now().strftime("%Y%m%d%H%M%S") + "001"),
            "indiamartId": snapshot.get("indiamartId", ""),
            "source": snapshot.get("source", "Email Log"),
            "name": snapshot.get("name") or parse_lead_name_from_body(email.get("body", ""), email.get("to", "")),
            "company": snapshot.get("company", ""),
            "email": email.get("to"),
            "phone": snapshot.get("phone", ""),
            "city": snapshot.get("city", ""),
            "state": snapshot.get("state", ""),
            "product": snapshot.get("product") or parse_product_from_subject(email.get("subject", "")),
            "message": snapshot.get("message", "Restored from auto email log"),
            "status": snapshot.get("status", "New"),
            "clientStatus": snapshot.get("clientStatus", "New"),
            "score": snapshot.get("score"),
            "aiSummary": snapshot.get("aiSummary"),
            "emailValid": True,
            "emailReason": "Restored from sent email log",
            "phoneValid": snapshot.get("phoneValid", False),
            "phoneLocation": snapshot.get("phoneLocation", ""),
            "phoneCarrier": snapshot.get("phoneCarrier", ""),
            "phoneLineType": snapshot.get("phoneLineType", ""),
            "phoneStatus": snapshot.get("phoneStatus", ""),
            "phoneOwner": snapshot.get("phoneOwner"),
            "createdAt": snapshot.get("createdAt") or email.get("sentAt") or datetime.utcnow().isoformat(),
            "updatedAt": datetime.utcnow().isoformat()
        }

        data["leads"].insert(0, restored_lead)
        email["leadId"] = restored_lead["id"]
        leads_by_id[restored_lead["id"]] = restored_lead
        leads_by_email[normalize_email(restored_lead["email"])] = restored_lead
        changed = True

    return changed

def load_data() -> Dict[str, Any]:
    if mongo_db is None:
        if not DATA_FILE.exists():
            return {"leads": [], "emails": [], "followups": []}
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            changed = False
            if "emails" in data and isinstance(data["emails"], list):
                seen = set()
                unique_emails = []
                lead_map = {l["id"]: l.get("email", "") for l in data.get("leads", []) if "id" in l}
                for e in data["emails"]:
                    if e.get("direction") == "received":
                        lead_email = lead_map.get(e.get("leadId"), "")
                        key = f"{lead_email.lower().strip()}_{(e.get('subject') or '').strip()}_{e.get('receivedAt') or ''}"
                        if key in seen:
                            continue
                        seen.add(key)
                    unique_emails.append(e)
                if len(unique_emails) != len(data["emails"]):
                    data["emails"] = unique_emails
                    changed = True
            if reconcile_email_lead_links(data):
                changed = True
            if changed:
                save_data(data)
            return data
        except Exception:
            return {"leads": [], "emails": [], "followups": []}

    try:
        doc = mongo_db.crm.find_one({"_id": "main"})
        if not doc:
            initial = {"_id": "main", "leads": [], "emails": [], "followups": []}
            mongo_db.crm.insert_one(initial)
            return initial
        changed = False
        if "emails" in doc and isinstance(doc["emails"], list):
            seen = set()
            unique_emails = []
            lead_map = {l["id"]: l.get("email", "") for l in doc.get("leads", []) if "id" in l}
            for e in doc["emails"]:
                if e.get("direction") == "received":
                    lead_email = lead_map.get(e.get("leadId"), "")
                    key = f"{lead_email.lower().strip()}_{(e.get('subject') or '').strip()}_{e.get('receivedAt') or ''}"
                    if key in seen:
                        continue
                    seen.add(key)
                unique_emails.append(e)
            if len(unique_emails) != len(doc["emails"]):
                doc["emails"] = unique_emails
                changed = True
        if reconcile_email_lead_links(doc):
            changed = True
        if changed:
            mongo_db.crm.update_one({"_id": "main"}, {"$set": {"leads": doc["leads"], "emails": doc["emails"]}})
        return doc
    except Exception as e:
        print(f"Error loading data from MongoDB: {e}")
        return {"leads": [], "emails": [], "followups": []}

def save_data(data: dict):
    if mongo_db is None:
        try:
            with open(DATA_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except Exception as err:
            print(f"Error writing local data file: {err}")
        return

    try:
        mongo_db.crm.update_one(
            {"_id": "main"},
            {"$set": {
                "leads": data.get("leads", []),
                "emails": data.get("emails", []),
                "followups": data.get("followups", []),
                "lastSyncTime": data.get("lastSyncTime")
            }},
            upsert=True
        )
    except Exception as err:
        print(f"Error saving data to MongoDB: {err}")
