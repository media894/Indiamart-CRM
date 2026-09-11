import os
import re
import socket
import smtplib
import imaplib
import email
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email import encoders
from pathlib import Path
from typing import Dict, Any, List, Tuple
import requests

from backend.config import BASE_DIR, PUBLIC_DIR, ASSETS_DIR, PDFS_DIR, load_settings_dict

# Local memory activity log
activity_log: List[Dict[str, Any]] = []

def push_activity(type_: str, title: str, detail: str, extra: dict = None):
    event = {
        "id": f"{int(socket.gethostname().__hash__())}_{len(activity_log)}",
        "type": type_,
        "title": title,
        "detail": detail,
        "time": os.getenv("CURRENT_TIME", "") or "just now"
    }
    if extra:
        event.update(extra)
    activity_log.insert(0, event)
    if len(activity_log) > 200:
        activity_log.pop()
    return event

def normalize_email(email_str: str) -> str:
    if not email_str:
        return ""
    s = str(email_str).strip().lower()
    match = re.search(r'<([^>]+)>', s)
    if match:
        return match.group(1).strip().lower()
    return s

def normalize_phone(phone_str: str) -> str:
    return re.sub(r'[^\d]', '', str(phone_str or ""))

def get_likely_email_typo(domain: str) -> str:
    typo_map = {
        'gmai.com': 'gmail.com', 'gmial.com': 'gmail.com', 'gmal.com': 'gmail.com',
        'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com', 'gmail.cm': 'gmail.com',
        'gmail.coom': 'gmail.com', 'gnail.com': 'gmail.com', 'yaho.com': 'yahoo.com',
        'yahoo.co': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'hotmial.com': 'hotmail.com',
        'hotmai.com': 'hotmail.com', 'outlok.com': 'outlook.com', 'outlook.co': 'outlook.com'
    }
    return typo_map.get(str(domain or "").lower(), "")

def validate_email_syntax(email_str: str) -> Dict[str, Any]:
    if not email_str:
        return {"valid": False, "reason": "No email provided"}
    raw = str(email_str)
    cleaned = raw.strip().lower()
    if raw != raw.strip():
        return {"valid": False, "reason": "Email has leading/trailing spaces"}
    if re.search(r'[,\s;<>()[\]"\'\\]', cleaned):
        return {"valid": False, "reason": "Email contains invalid spaces or punctuation"}

    email_regex = r'^[a-z0-9.!#$%&\'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$'
    if not re.match(email_regex, cleaned, re.IGNORECASE):
        return {"valid": False, "reason": "Invalid format"}

    parts = cleaned.split("@")
    if len(parts) != 2:
        return {"valid": False, "reason": "Invalid format"}
    local_part, domain = parts
    if not local_part or not domain:
        return {"valid": False, "reason": "Invalid format"}

    if local_part.startswith(".") or local_part.endswith(".") or ".." in local_part or ".." in domain:
        return {"valid": False, "reason": "Invalid dot placement in email"}

    domain_labels = domain.split(".")
    if any(not label or label.startswith("-") or label.endswith("-") for label in domain_labels):
        return {"valid": False, "reason": "Invalid email domain format"}

    tld = domain_labels[-1]
    if not re.match(r'^[a-z]{2,24}$', tld, re.IGNORECASE):
        return {"valid": False, "reason": "Invalid email domain extension"}

    typo = get_likely_email_typo(domain)
    if typo:
        return {"valid": False, "reason": f"Likely email domain typo. Did you mean {typo}?"}

    disposable_domains = {
        'yopmail.com', 'mailinator.com', 'tempmail.com', '10minutemail.com',
        'guerrillamail.com', 'throwawaymail.com', 'getairmail.com', 'dispostable.com',
        'temp-mail.org', 'tempmailo.com', 'emailondeck.com', 'sharklasers.com'
    }
    if domain in disposable_domains:
        return {"valid": False, "reason": "Disposable email domain (leads to bounce back)"}

    return {"valid": True, "reason": "Format & domain structure valid."}

def validate_phone_number(phone_str: str, numverify_key: str = "", fallback_city: str = "", fallback_state: str = "") -> Dict[str, Any]:
    if not phone_str:
        return {"valid": False, "location": "", "carrier": "", "lineType": "", "phoneStatus": "No phone number", "reason": "No phone number", "phoneOwner": None}
    
    clean_phone = re.sub(r'[^\d+]', '', str(phone_str))
    if not clean_phone:
        return {"valid": False, "location": "", "carrier": "", "lineType": "", "phoneStatus": "Invalid format", "reason": "Invalid format", "phoneOwner": None}

    if len(clean_phone) == 10 and re.match(r'^[6789]', clean_phone):
        clean_phone = '91' + clean_phone
    if not clean_phone.startswith('+') and len(clean_phone) >= 10:
        clean_phone = '+' + clean_phone

    format_valid = bool(re.match(r'^\+?\d{8,15}$', clean_phone.replace('+', '')))

    if numverify_key:
        try:
            num_for_verify = clean_phone.replace('+', '')
            url = f"http://apilayer.net/api/validate?access_key={numverify_key}&number={num_for_verify}"
            res = requests.get(url, timeout=5)
            data = res.json()
            if data and data.get("valid"):
                parts = []
                if data.get("location"):
                    parts.append(data.get("location"))
                if data.get("country_name"):
                    parts.append(data.get("country_name"))
                loc = ", ".join(parts) or ", ".join(filter(None, [fallback_city, fallback_state, "India"]))
                return {
                    "valid": True,
                    "location": loc,
                    "carrier": data.get("carrier") or "Unknown Operator",
                    "lineType": data.get("line_type") or "mobile",
                    "phoneStatus": "Active / In Use (Carrier Verified)",
                    "reason": "Numverify carrier verification successful",
                    "phoneOwner": None
                }
        except Exception as e:
            print(f"[Phone Validation] Numverify error: {e}")

    try:
        vp_num = clean_phone.replace('+', '')
        url = f"https://api.veriphone.io/v2/verify?phone={vp_num}&default_country=IN"
        res = requests.get(url, timeout=5)
        vp_data = res.json()
        if vp_data and vp_data.get("status") == "success" and vp_data.get("phone_valid"):
            vp_loc = ", ".join(filter(None, [vp_data.get("phone_region"), vp_data.get("country")])) or ", ".join(filter(None, [fallback_city, fallback_state, "India"]))
            return {
                "valid": True,
                "location": vp_loc,
                "carrier": vp_data.get("carrier") or "Unknown Operator",
                "lineType": vp_data.get("phone_type") or "mobile",
                "phoneStatus": "Active / In Use (Veriphone Verified)",
                "reason": "Veriphone carrier verification successful",
                "phoneOwner": None
            }
    except Exception as e:
        print(f"[Phone Validation] Veriphone error: {e}")

    if format_valid:
        loc = ", ".join(filter(None, [fallback_city, fallback_state, "India"]))
        return {
            "valid": True,
            "location": loc,
            "carrier": "Unknown Operator",
            "lineType": "mobile",
            "phoneStatus": "Active / In Use (Format Check)",
            "reason": "Format check valid",
            "phoneOwner": None
        }

    return {
        "valid": False, "location": "", "carrier": "", "lineType": "", "phoneStatus": "Not In Use / Disconnected", "reason": "Invalid format", "phoneOwner": None
    }

def get_name_from_email(email_str: str) -> str:
    if not email_str or "@" not in email_str:
        return "Sir/Madam"
    username = email_str.split("@")[0]
    username = re.sub(r'[._\-+]', ' ', username)
    username = re.sub(r'\d+', '', username).strip()
    if not username:
        return "Sir/Madam"
    return " ".join([w.capitalize() for w in username.split() if w]).strip() or "Sir/Madam"

def get_greeting_name(lead: dict) -> str:
    name = lead.get("name", "").strip()
    if not name or name.lower() == "unknown":
        name = get_name_from_email(lead.get("email", ""))
    return re.sub(r'[*#`_~]', '', name).strip() or "Sir/Madam"

def get_lead_service_key(lead: dict) -> str:
    haystack = f"{lead.get('product', '')} {lead.get('message', '')}".lower()

    if re.search(r'(aircraft\s*cabin\s*mockup|cabin\s*mockup)', haystack):
        return 'graphic'

    if not re.search(r'(hand\s*embroidery|cotton\s*embroidery)', haystack):
        if (
            re.search(r'(t[\s-]*shirt|tee\s*shirt|polo\s*(?:t[\s-]*shirt|shirt)|round\s*neck|v[\s-]*neck|u[\s-]*neck|half\s*sleeve|full\s*sleeve).*(embroidery|embroidered|machine\s*embroidery|computerized\s*embroidery|logo\s*embroidery|uniform\s*embroidery|stitch(?:ing)?|thread\s*work)', haystack) or
            re.search(r'(embroidery|embroidered|machine\s*embroidery|computerized\s*embroidery|logo\s*embroidery|stitch(?:ing)?).*(t[\s-]*shirt|tee\s*shirt|polo\s*(?:t[\s-]*shirt|shirt)|round\s*neck|v[\s-]*neck|u[\s-]*neck|half\s*sleeve|full\s*sleeve)', haystack) or
            re.search(r'(uniform|garment|apparel|jacket|hoodie|cap|hat|jersey|sports\s*wear|sportswear|corporate\s*wear|work\s*wear|workwear).*(embroidery|embroidered|stitch(?:ing)?)', haystack) or
            re.search(r't[\s-]?shirt\s*embroidery|embroidery\s*t[\s-]?shirt', haystack)
        ):
            return 'tshirtembroidery'

    if (
        re.search(r'(t[\s-]*shirt|tee\s*shirt|polo\s*(?:t[\s-]*shirt|shirt)|round\s*neck|v[\s-]*neck|u[\s-]*neck|half\s*sleeve|full\s*sleeve).*(printing|print(?:ed)?|dtf|screen\s*printing|sublimation|heat\s*transfer|logo\s*print(?:ing)?|custom\s*print(?:ing)?)', haystack) or
        re.search(r'(printing|print(?:ed)?|dtf|screen\s*printing|sublimation|heat\s*transfer|logo\s*print(?:ing)?).*(t[\s-]*shirt|tee\s*shirt|polo\s*(?:t[\s-]*shirt|shirt)|round\s*neck|v[\s-]*neck|u[\s-]*neck|half\s*sleeve|full\s*sleeve)', haystack) or
        re.search(r't[\s-]?shirt\s*print(?:ing)?|print(?:ing)?\s*t[\s-]?shirt', haystack)
    ):
        return 'tshirtprinting'

    if re.search(r'(graphic\s*design|brochure\s*design|catalogue\s*design|catalog\s*design|flyer\s*design|banner\s*design|logo\s*design|menu\s*card\s*design|brand\s*identity|poster\s*design|business\s*card|visiting\s*card|package\s*design|packaging|label\s*design|sticker\s*design)', haystack):
        return 'graphic'

    if re.search(r'(data\s*entry|online\s*data\s*entry|offline\s*data\s*entry|excel\s*data\s*entry|data\s*mining|data\s*conversion|pdf\s*to\s*(excel|word|csv)|pdf\s*edit|data\s*typing|copy\s*paste)', haystack):
        return 'dataentry'

    if re.search(r'(embroidery\s*digit|digitiz|embroidery\s*file|\bpes\b|\bdst\b|\bjef\b|\bemb\b|embroidery)', haystack):
        return 'embroidery'

    if re.search(r'(live\s*chat|chat\s*support|web\s*chat|customer\s*service|customer\s*support|help\s*desk|helpdesk|call\s*cent)', haystack):
        return 'livechat'

    if re.search(r'(image\s*edit|photo\s*edit|photo\s*retouch|image\s*retouch|clipping\s*path|background\s*remov|ghost\s*mannequin|color\s*correct)', haystack):
        return 'imageediting'

    if re.search(r'(email\s*marketing|email\s*campaign|bulk\s*email|email\s*automation|email\s*template|mailchimp|klaviyo)', haystack):
        return 'emailmarketing'

    if re.search(r'(vector\s*art|vector\s*design|redraw|raster\s*to\s*vector|image\s*to\s*vector|logo\s*vector)', haystack):
        return 'vector'

    if re.search(r'(\bai\b|artificial\s*intelligence|machine\s*learning|\bml\b|generative\s*ai|chatbot)', haystack):
        return 'aiml'

    return 'graphic'

def get_lead_pdf_path(lead: dict) -> str:
    main_service = get_lead_service_key(lead)
    haystack = f"{lead.get('product', '')} {lead.get('message', '')}".lower()

    if main_service == 'logo' or 'logo' in haystack:
        target = PDFS_DIR / "Logo Portfolio.pdf"
    elif main_service == 'imageediting':
        target = PDFS_DIR / "Image Editing Services Portfolio.pdf"
    elif main_service in ['graphic', 'tshirtprinting', 'vector']:
        target = PDFS_DIR / "Graphic Designing Portfolio.pdf"
    else:
        return ""

    if target.exists():
        return str(target)
    return ""

def is_smtp_configured(settings: dict) -> bool:
    return bool(settings.get("smtpHost") and settings.get("smtpUser") and settings.get("smtpPass"))

def send_email_smtp(settings: dict, to_email: str, subject: str, html_body: str, text_body: str = "", attachments: list = None) -> bool:
    host = settings.get("smtpHost", "")
    port = int(settings.get("smtpPort", 587))
    user = settings.get("smtpUser", "")
    password = settings.get("smtpPass", "")

    # Brevo HTTP API Fallback check
    if "brevo.com" in host or password.startswith("xsmtpsib-") or password.startswith("xkeysib-"):
        try:
            payload = {
                "sender": {"name": "ODD INFOTECH", "email": user},
                "to": [{"email": to_email}],
                "subject": subject,
                "htmlContent": html_body
            }
            res = requests.post(
                "https://api.brevo.com/v3/smtp/email",
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "api-key": password
                },
                json=payload,
                timeout=15
            )
            if res.status_code in [200, 201, 202]:
                return True
            else:
                print(f"[Brevo HTTP Error] {res.text}")
        except Exception as e:
            print(f"[Brevo API Error] {e}")

    try:
        msg = MIMEMultipart('alternative')
        msg['From'] = user
        msg['To'] = to_email
        msg['Subject'] = subject

        if text_body:
            msg.attach(MIMEText(text_body, 'plain'))
        if html_body:
            msg.attach(MIMEText(html_body, 'html'))

        if port == 465:
            server = smtplib.SMTP_SSL(host, port, timeout=30)
        else:
            server = smtplib.SMTP(host, port, timeout=30)
            server.starttls()

        server.login(user, password)
        server.sendmail(user, [to_email], msg.as_string())
        server.quit()
        return True
    except Exception as e:
        print(f"[SMTP Send Error] {e}")
        raise e
