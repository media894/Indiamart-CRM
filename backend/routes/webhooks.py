from datetime import datetime
from fastapi import APIRouter, HTTPException, Request
from backend.database import load_data, save_data
from backend.services.mail_service import normalize_phone
from backend.services.conversation_manager import cancel_followup
from backend.services.agent import process_buyer_message
from backend.services.whatsapp_service import send_whatsapp_message
from backend.services.mail_service import push_activity

router = APIRouter(prefix="/api", tags=["Webhooks & Quotes"])

@router.post("/webhooks/whatsapp")
async def incoming_whatsapp_webhook(payload: dict):
    from_phone = payload.get("from") or payload.get("phone") or payload.get("from_phone")
    message_text = payload.get("text") or payload.get("body") or payload.get("message", "")

    if not from_phone or not message_text:
        raise HTTPException(status_code=400, detail="Missing from phone or message text")

    d = load_data()
    phone_key = normalize_phone(from_phone)

    # Find matching lead by phone
    lead = None
    for l in d.get("leads", []):
        lp = normalize_phone(l.get("phone", ""))
        if lp and (lp == phone_key or phone_key.endswith(lp) or lp.endswith(phone_key)):
            lead = l
            break

    if not lead:
        # Auto create manual lead if unknown buyer messages
        lead_id = datetime.now().strftime("%Y%m%d%H%M%S") + "001"
        lead = {
            "id": lead_id,
            "source": "WhatsApp Webhook",
            "name": f"WhatsApp Client ({from_phone[-4:]})",
            "phone": from_phone,
            "status": "New",
            "clientStatus": "Replied via WhatsApp",
            "createdAt": datetime.utcnow().isoformat(),
            "updatedAt": datetime.utcnow().isoformat()
        }
        d["leads"].insert(0, lead)
        save_data(d)

    # 1. CANCEL 7-Day Follow-Up Timer immediately upon receiving buyer message
    cancel_followup(lead["id"], reason="CANCELLED_BY_BUYER_REPLY")

    # 2. Process message via AI Agent
    ai_result = process_buyer_message(lead, message_text)
    reply_text = ai_result["reply_text"]

    # 3. Log incoming & outgoing messages to database
    if "emails" not in d:
        d["emails"] = []

    # Inbound message log
    d["emails"].append({
        "id": f"in_{datetime.now().strftime('%Y%m%d%H%M%S')}",
        "leadId": lead["id"],
        "from": from_phone,
        "body": message_text,
        "direction": "received",
        "channel": "whatsapp",
        "receivedAt": datetime.utcnow().isoformat()
    })

    # Outbound AI Reply log
    d["emails"].append({
        "id": f"out_{datetime.now().strftime('%Y%m%d%H%M%S')}",
        "leadId": lead["id"],
        "to": from_phone,
        "body": reply_text,
        "direction": "sent",
        "channel": "whatsapp",
        "aiReply": True,
        "sentAt": datetime.utcnow().isoformat()
    })

    # Save generated quote / payment link info if present
    if "quotes" not in d:
        d["quotes"] = []
    
    quote_entry = {
        "id": f"q_{lead['id']}",
        "leadId": lead["id"],
        "leadName": lead.get("name"),
        "phone": from_phone,
        "details": ai_result.get("quote"),
        "payment": ai_result.get("payment_info"),
        "status": "Quote Sent",
        "createdAt": datetime.utcnow().isoformat()
    }
    d["quotes"].insert(0, quote_entry)

    # Update lead status
    idx = next((i for i, l in enumerate(d["leads"]) if l["id"] == lead["id"]), -1)
    if idx != -1:
        d["leads"][idx]["clientStatus"] = "AI Replied via WhatsApp"
        d["leads"][idx]["replied"] = True
        d["leads"][idx]["updatedAt"] = datetime.utcnow().isoformat()

    save_data(d)

    # Dispatch reply back on WhatsApp
    try:
        send_whatsapp_message(from_phone, reply_text)
    except Exception as e:
        print(f"[Webhook] Error sending reply to {from_phone}: {e}")

    return {"ok": True, "leadId": lead["id"], "ai_reply": reply_text, "quote": ai_result.get("quote")}

@router.api_route("/webhooks/payment", methods=["GET", "POST"])
async def payment_webhook(request: Request):
    d = load_data()
    params = dict(request.query_params)
    
    payment_id = params.get("razorpay_payment_id") or "pay_success"
    payment_link_id = params.get("razorpay_payment_link_id")

    if "quotes" in d:
        for q in d["quotes"]:
            if payment_link_id and q.get("payment", {}).get("payment_link_id") == payment_link_id:
                q["status"] = "PAID"
                q["paidAt"] = datetime.utcnow().isoformat()
                q["payment_id"] = payment_id
                
                # Update lead status to Client
                lead_id = q.get("leadId")
                idx = next((i for i, l in enumerate(d.get("leads", [])) if l["id"] == lead_id), -1)
                if idx != -1:
                    d["leads"][idx]["clientStatus"] = "Client (Paid)"

    save_data(d)
    return {"ok": True, "status": "Payment Processed", "payment_id": payment_id}

@router.get("/quotes")
def get_quotes():
    d = load_data()
    return d.get("quotes", [])
