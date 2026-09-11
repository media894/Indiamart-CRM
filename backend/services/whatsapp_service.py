import io
import base64
import qrcode
from typing import Dict, Any

whatsapp_status = "DISCONNECTED"
qr_code_data = None

def initialize_whatsapp():
    global whatsapp_status, qr_code_data
    print("[WhatsApp Service] Initializing WhatsApp module...")
    whatsapp_status = "DISCONNECTED"
    qr_code_data = None

def get_whatsapp_status() -> Dict[str, Any]:
    global whatsapp_status, qr_code_data
    return {
        "status": whatsapp_status,
        "qrCodeData": qr_code_data
    }

def generate_sample_qr() -> str:
    global qr_code_data, whatsapp_status
    whatsapp_status = "SCAN_REQUIRED"
    qr = qrcode.QRCode(version=1, box_size=10, border=5)
    qr.add_data("https://web.whatsapp.com")
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")

    buffered = io.BytesIO()
    img.save(buffered, format="PNG")
    img_str = base64.b64encode(buffered.getvalue()).decode()
    qr_code_data = f"data:image/png;base64,{img_str}"
    return qr_code_data

def disconnect_whatsapp():
    global whatsapp_status, qr_code_data
    whatsapp_status = "DISCONNECTED"
    qr_code_data = None
    print("[WhatsApp Service] Disconnected.")

def reconnect_whatsapp(clear_session: bool = True):
    global whatsapp_status, qr_code_data
    print(f"[WhatsApp Service] Reconnecting... (clear_session={clear_session})")
    whatsapp_status = "DISCONNECTED"
    qr_code_data = None
    generate_sample_qr()

def send_whatsapp_message(to_phone: str, message_text: str):
    global whatsapp_status
    if whatsapp_status != "CONNECTED":
        # Auto connect for testing if needed
        whatsapp_status = "CONNECTED"
    print(f"[WhatsApp Service] Sending message to {to_phone}: {message_text[:40]}...")
    return {"status": "sent", "to": to_phone}

def send_whatsapp_media(to_phone: str, media_path: str, caption: str = ""):
    print(f"[WhatsApp Service] Sending media {media_path} to {to_phone}...")
    return {"status": "sent", "to": to_phone, "media": media_path}
