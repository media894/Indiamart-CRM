from datetime import datetime
from fastapi import APIRouter, HTTPException
from backend.database import load_data, save_data
from backend.config import load_settings_dict
from backend.services.mail_service import send_email_smtp, is_smtp_configured

router = APIRouter(prefix="/api", tags=["Email"])

@router.get("/emails")
def get_emails():
    d = load_data()
    return d.get("emails", [])

@router.get("/emails/{lead_id}")
def get_emails_for_lead(lead_id: str):
    d = load_data()
    return [e for e in d.get("emails", []) if e.get("leadId") == lead_id]

@router.post("/send-email")
def send_email(payload: dict):
    settings = load_settings_dict()
    lead_id = payload.get("leadId")
    to_email = payload.get("to")
    subject = payload.get("subject", "Enquiry Response")
    body = payload.get("body", "")

    if not to_email or not body:
        raise HTTPException(status_code=400, detail="Recipient email and body are required")

    d = load_data()
    if "emails" not in d:
        d["emails"] = []

    email_record = {
        "id": datetime.now().strftime("%Y%m%d%H%M%S") + "001",
        "leadId": lead_id,
        "to": to_email,
        "subject": subject,
        "body": body,
        "direction": "sent",
        "sentAt": datetime.utcnow().isoformat(),
        "attachments": payload.get("attachments", [])
    }
    d["emails"].append(email_record)

    if lead_id:
        idx = next((i for i, l in enumerate(d.get("leads", [])) if l["id"] == lead_id), -1)
        if idx != -1:
            d["leads"][idx]["clientStatus"] = "Emailed"
            d["leads"][idx]["emailSent"] = True
            d["leads"][idx]["lastEmailSentAt"] = email_record["sentAt"]
            d["leads"][idx]["updatedAt"] = email_record["sentAt"]

    save_data(d)

    if is_smtp_configured(settings):
        try:
            send_email_smtp(settings, to_email, subject, body.replace("\n", "<br>"), body)
            return {"ok": True, "sent": True, "emailId": email_record["id"]}
        except Exception as e:
            return {"ok": True, "sent": False, "logged": True, "error": str(e), "emailId": email_record["id"]}
    else:
        return {"ok": True, "sent": False, "logged": True, "note": "SMTP not configured — email logged only", "emailId": email_record["id"]}

@router.post("/send-bulk-email")
def send_bulk_email(payload: dict):
    settings = load_settings_dict()
    subject = payload.get("subject")
    body = payload.get("body")
    lead_ids = payload.get("leadIds", [])
    statuses = payload.get("statuses", [])

    if not subject or not body:
        raise HTTPException(status_code=400, detail="Subject and body are required")

    d = load_data()
    if "emails" not in d:
        d["emails"] = []

    if lead_ids:
        id_set = set(lead_ids)
        targets = [l for l in d.get("leads", []) if l["id"] in id_set and l.get("email")]
    elif statuses:
        targets = [l for l in d.get("leads", []) if l.get("status") in statuses and l.get("email")]
    else:
        raise HTTPException(status_code=400, detail="No target leads specified")

    results = []
    for lead in targets:
        p_subject = subject.replace("{{name}}", lead.get("name", "")).replace("{{company}}", lead.get("company", "")).replace("{{product}}", lead.get("product", ""))
        p_body = body.replace("{{name}}", lead.get("name", "")).replace("{{company}}", lead.get("company", "")).replace("{{product}}", lead.get("product", ""))

        email_record = {
            "id": datetime.now().strftime("%Y%m%d%H%M%S") + "001",
            "leadId": lead["id"],
            "to": lead["email"],
            "subject": p_subject,
            "body": p_body,
            "direction": "sent",
            "sentAt": datetime.utcnow().isoformat(),
            "bulk": True
        }

        sent = False
        error = None
        if is_smtp_configured(settings):
            try:
                send_email_smtp(settings, lead["email"], p_subject, p_body.replace("\n", "<br>"), p_body)
                sent = True
            except Exception as e:
                error = str(e)

        d["emails"].append(email_record)
        results.append({"leadId": lead["id"], "email": lead["email"], "sent": sent, "error": error})

    save_data(d)
    sent_count = len([r for r in results if r["sent"]])
    return {"ok": True, "sent": sent_count, "failed": len(results) - sent_count, "total": len(results), "results": results}
