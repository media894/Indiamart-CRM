from fastapi import APIRouter, HTTPException
from backend.database import load_data, save_data
from backend.config import load_settings_dict
from backend.services.whatsapp_service import (
    get_whatsapp_status,
    disconnect_whatsapp,
    reconnect_whatsapp,
    send_whatsapp_message,
    send_whatsapp_media,
    generate_sample_qr
)

router = APIRouter(prefix="/api/whatsapp", tags=["WhatsApp"])

@router.get("/status")
def whatsapp_status_endpoint():
    status = get_whatsapp_status()
    if status.get("status") == "DISCONNECTED" and not status.get("qrCodeData"):
        generate_sample_qr()
        status = get_whatsapp_status()
    return status

@router.post("/disconnect")
def whatsapp_disconnect_endpoint():
    disconnect_whatsapp()
    return {"ok": True}

@router.post("/reconnect")
def whatsapp_reconnect_endpoint(payload: dict = None):
    clear_session = payload.get("clearSession", True) if payload else True
    reconnect_whatsapp(clear_session=clear_session)
    return {"ok": True}

@router.post("/send-template")
def send_whatsapp_template(payload: dict):
    lead_id = payload.get("leadId")
    if not lead_id:
        raise HTTPException(status_code=400, detail="leadId is required")

    d = load_data()
    lead = next((l for l in d.get("leads", []) if l["id"] == lead_id), None)
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if not lead.get("phone"):
        raise HTTPException(status_code=400, detail="Lead has no phone number")

    settings = load_settings_dict()
    template_text = settings.get("whatsappTemplates", {}).get("default", "")
    if not template_text:
        template_text = (
            "Hi {{name}},\n\nI am Natasha on behalf of Odd infotech and I got your enquiry in indiamart regarding {{product}}.\n\n"
            "Kindly please share more details about your requirements. Let me know the suitable time to talk to you."
        )

    msg = template_text.replace("{{name}}", lead.get("name", "Sir/Madam")) \
                       .replace("{{product}}", lead.get("product", "our services")) \
                       .replace("{{company}}", lead.get("company", ""))

    try:
        send_whatsapp_message(lead["phone"], msg)

        # Log outbound message
        if "emails" not in d:
            d["emails"] = []
        d["emails"].append({
            "id": f"wa_{lead_id}",
            "leadId": lead_id,
            "to": f"{lead['phone']} (WhatsApp)",
            "subject": "WhatsApp Message",
            "body": msg,
            "direction": "sent",
            "channel": "whatsapp"
        })

        idx = next(i for i, l in enumerate(d["leads"]) if l["id"] == lead_id)
        d["leads"][idx]["clientStatus"] = "WhatsApp Sent"
        d["leads"][idx]["whatsappSent"] = True
        save_data(d)

        return {"ok": True, "message": "WhatsApp message sent successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
