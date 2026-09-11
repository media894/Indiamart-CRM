import io
from datetime import datetime
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import Response, StreamingResponse
import pandas as pd
import openpyxl

from backend.database import load_data, save_data
from backend.config import load_settings_dict
from backend.services.mail_service import validate_email_syntax, validate_phone_number
from backend.services.ai_qualifier import qualify_lead

router = APIRouter(prefix="/api", tags=["Leads"])

@router.get("/leads")
def get_leads():
    d = load_data()
    return d.get("leads", [])

@router.post("/leads")
def create_lead(lead_data: dict):
    d = load_data()
    settings = load_settings_dict()

    email_val = validate_email_syntax(lead_data.get("email", ""))
    phone_val = validate_phone_number(
        lead_data.get("phone", ""),
        settings.get("numverifyKey", ""),
        lead_data.get("city", ""),
        lead_data.get("state", "")
    )

    lead_id = datetime.now().strftime("%Y%m%d%H%M%S") + "001"
    new_lead = {
        "id": lead_id,
        "source": "Manual",
        "status": "New",
        "clientStatus": "New",
        "score": None,
        "aiSummary": None,
        "createdAt": datetime.utcnow().isoformat(),
        "updatedAt": datetime.utcnow().isoformat(),
        **lead_data,
        "emailValid": email_val["valid"],
        "emailReason": email_val["reason"],
        "phoneValid": phone_val["valid"],
        "phoneLocation": phone_val["location"],
        "phoneCarrier": phone_val["carrier"],
        "phoneLineType": phone_val["lineType"],
        "phoneStatus": phone_val["phoneStatus"],
        "phoneOwner": phone_val.get("phoneOwner")
    }

    d["leads"].insert(0, new_lead)
    save_data(d)
    return new_lead

@router.put("/leads/{lead_id}")
def update_lead(lead_id: str, lead_data: dict):
    d = load_data()
    idx = next((i for i, l in enumerate(d.get("leads", [])) if l["id"] == lead_id), -1)
    if idx == -1:
        raise HTTPException(status_code=404, detail="Lead not found")

    settings = load_settings_dict()
    updated_fields = dict(lead_data)

    current_lead = d["leads"][idx]
    if "email" in lead_data and lead_data["email"] != current_lead.get("email"):
        email_val = validate_email_syntax(lead_data["email"])
        updated_fields["emailValid"] = email_val["valid"]
        updated_fields["emailReason"] = email_val["reason"]

    if ("phone" in lead_data and lead_data["phone"] != current_lead.get("phone")) or \
       ("city" in lead_data and lead_data["city"] != current_lead.get("city")) or \
       ("state" in lead_data and lead_data["state"] != current_lead.get("state")):
        phone_val = validate_phone_number(
            lead_data.get("phone", current_lead.get("phone", "")),
            settings.get("numverifyKey", ""),
            lead_data.get("city", current_lead.get("city", "")),
            lead_data.get("state", current_lead.get("state", ""))
        )
        updated_fields["phoneValid"] = phone_val["valid"]
        updated_fields["phoneLocation"] = phone_val["location"]
        updated_fields["phoneCarrier"] = phone_val["carrier"]
        updated_fields["phoneLineType"] = phone_val["lineType"]
        updated_fields["phoneStatus"] = phone_val["phoneStatus"]

    current_lead.update(updated_fields)
    current_lead["updatedAt"] = datetime.utcnow().isoformat()
    d["leads"][idx] = current_lead
    save_data(d)
    return current_lead

@router.delete("/leads/{lead_id}")
def delete_lead(lead_id: str):
    d = load_data()
    d["leads"] = [l for l in d.get("leads", []) if l["id"] != lead_id]
    save_data(d)
    return {"ok": True}

@router.post("/qualify/{lead_id}")
def qualify_lead_endpoint(lead_id: str):
    d = load_data()
    lead = next((l for l in d.get("leads", []) if l["id"] == lead_id), None)
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    settings = load_settings_dict()
    q = qualify_lead(lead, settings.get("geminiKey", ""))

    idx = next(i for i, l in enumerate(d["leads"]) if l["id"] == lead_id)
    d["leads"][idx]["score"] = q.get("score")
    d["leads"][idx]["status"] = q.get("status")
    d["leads"][idx]["aiSummary"] = q.get("summary")
    d["leads"][idx]["updatedAt"] = datetime.utcnow().isoformat()
    save_data(d)

    return {"lead": d["leads"][idx], "qualify": q}

@router.get("/export/csv")
def export_csv():
    d = load_data()
    headers = ['Name','Company','Email','Phone','City','State','Product','Message','Status','AI Score','Client Status','Source','Created']
    rows = []
    for l in d.get("leads", []):
        rows.append([
            l.get("name", ""), l.get("company", ""), l.get("email", ""), l.get("phone", ""),
            l.get("city", ""), l.get("state", ""), l.get("product", ""),
            str(l.get("message", "")).replace("\n", " "), l.get("status", "New"),
            str(l.get("score") or ""), l.get("clientStatus", "New"), l.get("source", ""),
            str(l.get("createdAt", ""))[:10]
        ])
    
    df = pd.DataFrame(rows, columns=headers)
    csv_str = df.to_csv(index=False)
    return Response(content=csv_str, media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="leads.csv"'})
