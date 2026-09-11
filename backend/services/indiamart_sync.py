import time
import requests
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, List

from backend.config import load_settings_dict
from backend.database import load_data, save_data, normalize_email
from backend.services.mail_service import validate_email_syntax, validate_phone_number, send_email_smtp, is_smtp_configured, push_activity
from backend.services.whatsapp_service import send_whatsapp_message, get_whatsapp_status

MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

def format_indiamart_date(dt: datetime) -> str:
    # Convert to IST (+5:30)
    ist = dt + timedelta(hours=5, minutes=30)
    dd = str(ist.day).zfill(2)
    mm = MONTHS[ist.month - 1]
    yyyy = str(ist.year)
    hh = str(ist.hour).zfill(2)
    mi = str(ist.minute).zfill(2)
    ss = str(ist.second).zfill(2)
    return f"{dd}-{mm}-{yyyy} {hh}:{mi}:{ss}"

def execute_indiamart_sync(settings: dict = None) -> Dict[str, Any]:
    if not settings:
        settings = load_settings_dict()

    if settings.get("indiamartSyncEnabled") is False or settings.get("autoResponseEnabled") is False:
        raise Exception("Webapp is OFF. Turn ON to fetch IndiaMART leads.")

    api_key = settings.get("indiamartApiKey")
    if not api_key:
        raise Exception("IndiaMART API key not configured")

    end = datetime.utcnow()
    start = end - timedelta(hours=24)

    start_str = format_indiamart_date(start)
    end_str = format_indiamart_date(end)

    url = f"https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key={api_key}&start_time={requests.utils.quote(start_str)}&end_time={requests.utils.quote(end_str)}"
    print(f"[IndiaMART Sync] Fetching: {url}")

    try:
        res = requests.get(url, headers={"Accept": "application/json"}, timeout=15)
        text = res.text
    except Exception as e:
        raise Exception(f"Failed to reach IndiaMART API: {e}")

    try:
        data_json = res.json()
    except Exception:
        raise Exception(f"Bad response from IndiaMART: {text[:500]}")

    if str(data_json.get("CODE")) == "429":
        raise Exception(data_json.get("MESSAGE") or "IndiaMART API limit reached. Please wait 5 minutes.")

    if data_json.get("STATUS") in ["Error", "FAILURE"] or data_json.get("CODE") == "error":
        raise Exception(data_json.get("MESSAGE") or data_json.get("message") or "IndiaMART API error")

    db_data = load_data()
    existing_ids = set(l.get("indiamartId") for l in db_data.get("leads", []) if l.get("indiamartId"))
    added = 0

    raw_leads = data_json.get("RESPONSE") or data_json.get("response") or data_json.get("DATA") or data_json.get("data") or data_json.get("leads") or []
    if isinstance(raw_leads, dict):
        raw_leads = [raw_leads]

    for l in raw_leads:
        im_id = str(l.get("UNIQUE_QUERY_ID") or l.get("unique_query_id") or l.get("QUERY_ID") or "")
        if im_id and im_id in existing_ids:
            continue

        lead_email = l.get("SENDER_EMAIL") or l.get("sender_email") or ""
        lead_phone = l.get("SENDER_MOBILE") or l.get("sender_mobile") or l.get("SENDER_PHONE") or l.get("sender_phone") or ""

        email_val = validate_email_syntax(lead_email)
        phone_val = validate_phone_number(
            lead_phone,
            settings.get("numverifyKey", ""),
            l.get("SENDER_CITY") or l.get("sender_city") or "",
            l.get("SENDER_STATE") or l.get("sender_state") or ""
        )

        raw_msg = l.get("QUERY_MESSAGE") or l.get("query_message") or ""
        q_type = l.get("QUERY_TYPE") or l.get("query_type") or ""
        if not q_type:
            if "buyer searched for" in raw_msg.lower() or "requirement for" in raw_msg.lower():
                q_type = "BL"
            else:
                q_type = "W"
        if q_type == "B":
            q_type = "BL"

        lead_id = datetime.now().strftime("%Y%m%d%H%M%S") + str(added).zfill(3)
        lead = {
            "id": lead_id,
            "indiamartId": im_id,
            "source": "IndiaMART",
            "queryType": q_type,
            "name": l.get("SENDER_NAME") or l.get("sender_name") or "Unknown",
            "company": l.get("SENDER_COMPANY") or l.get("sender_company") or "",
            "email": lead_email,
            "phone": lead_phone,
            "city": l.get("SENDER_CITY") or l.get("sender_city") or "",
            "state": l.get("SENDER_STATE") or l.get("sender_state") or "",
            "product": l.get("QUERY_PRODUCT_NAME") or l.get("query_product_name") or "",
            "message": raw_msg,
            "status": "New",
            "clientStatus": "New",
            "score": None,
            "aiSummary": None,
            "emailValid": email_val["valid"],
            "emailReason": email_val["reason"],
            "phoneValid": phone_val["valid"],
            "phoneLocation": phone_val["location"],
            "phoneCarrier": phone_val["carrier"],
            "phoneLineType": phone_val["lineType"],
            "phoneStatus": phone_val["phoneStatus"],
            "phoneOwner": phone_val.get("phoneOwner"),
            "createdAt": l.get("QUERY_TIME") or l.get("query_time") or datetime.utcnow().isoformat(),
            "updatedAt": datetime.utcnow().isoformat()
        }

        db_data["leads"].insert(0, lead)
        if im_id:
            existing_ids.add(im_id)
        added += 1

        push_activity(
            "new_lead",
            f"🆕 New Lead — {lead['name']}",
            f"{lead['product']} | {lead['email']} | {lead['city']}",
            {"leadId": lead["id"], "email": lead["email"], "product": lead["product"]}
        )

    db_data["lastSyncTime"] = datetime.utcnow().isoformat()
    save_data(db_data)

    return {"added": added, "total": len(raw_leads), "leads": db_data["leads"]}
