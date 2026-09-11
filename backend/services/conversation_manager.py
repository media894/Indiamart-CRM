from datetime import datetime, timedelta
from typing import Dict, Any, List
from backend.database import load_data, save_data

def schedule_followup(lead_id: str, days: int = 7) -> Dict[str, Any]:
    d = load_data()
    idx = next((i for i, l in enumerate(d.get("leads", [])) if l["id"] == lead_id), -1)
    if idx != -1:
        due_at = (datetime.utcnow() + timedelta(days=days)).isoformat()
        d["leads"][idx]["followupStatus"] = "SCHEDULED"
        d["leads"][idx]["followupDueAt"] = due_at
        d["leads"][idx]["replied"] = False
        d["leads"][idx]["updatedAt"] = datetime.utcnow().isoformat()
        save_data(d)
        print(f"[ConversationManager] Scheduled {days}-day followup for lead {lead_id} at {due_at}")
        return d["leads"][idx]
    return {}

def cancel_followup(lead_id: str, reason: str = "CANCELLED_BY_REPLY") -> Dict[str, Any]:
    d = load_data()
    idx = next((i for i, l in enumerate(d.get("leads", [])) if l["id"] == lead_id), -1)
    if idx != -1:
        d["leads"][idx]["followupStatus"] = reason
        d["leads"][idx]["replied"] = True
        d["leads"][idx]["updatedAt"] = datetime.utcnow().isoformat()
        save_data(d)
        print(f"[ConversationManager] Cancelled followup for lead {lead_id}. Reason: {reason}")
        return d["leads"][idx]
    return {}

def get_due_followups() -> List[Dict[str, Any]]:
    d = load_data()
    now_str = datetime.utcnow().isoformat()
    due_leads = []
    for l in d.get("leads", []):
        if l.get("followupStatus") == "SCHEDULED" and not l.get("replied"):
            due_at = l.get("followupDueAt", "")
            if due_at and due_at <= now_str:
                due_leads.append(l)
    return due_leads
