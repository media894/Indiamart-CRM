import os
import json
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
ASSETS_DIR = FRONTEND_DIR / "static" / "assets"
SERVER_DIR = BASE_DIR / "server"
PUBLIC_DIR = BASE_DIR / "public"
PDFS_DIR = SERVER_DIR / "pdfs"

DATA_FILE = SERVER_DIR / "data.json"
SETTINGS_FILE = SERVER_DIR / "settings.json"

PORT = int(os.getenv("PORT", 3000))
HOST = os.getenv("HOST", "0.0.0.0")
MONGODB_URI = os.getenv("MONGODB_URI", "")

# Ensure asset directories exist
ASSETS_DIR.mkdir(parents=True, exist_ok=True)
PDFS_DIR.mkdir(parents=True, exist_ok=True)

def load_settings_dict():
    s = {}
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                s = json.load(f)
        except Exception:
            s = {}

    # Environment variables override settings.json
    if os.getenv("INDIAMART_API_KEY"):
        s["indiamartApiKey"] = os.getenv("INDIAMART_API_KEY")
    if os.getenv("GEMINI_API_KEY"):
        s["geminiKey"] = os.getenv("GEMINI_API_KEY")
    if os.getenv("NUMVERIFY_API_KEY"):
        s["numverifyKey"] = os.getenv("NUMVERIFY_API_KEY")
    if os.getenv("SMTP_HOST"):
        s["smtpHost"] = os.getenv("SMTP_HOST")
    if os.getenv("SMTP_PORT"):
        s["smtpPort"] = os.getenv("SMTP_PORT")
    if os.getenv("SMTP_USER"):
        s["smtpUser"] = os.getenv("SMTP_USER")
    if os.getenv("SMTP_PASS"):
        s["smtpPass"] = os.getenv("SMTP_PASS")
    if os.getenv("IMAP_PASS"):
        s["imapPass"] = os.getenv("IMAP_PASS")

    if s.get("autoResponseEnabled") is None:
        s["autoResponseEnabled"] = True
    if s.get("indiamartSyncEnabled") is None:
        s["indiamartSyncEnabled"] = True
    if not s.get("autoResponseSubject"):
        s["autoResponseSubject"] = "Thank you for your enquiry!"
    if not s.get("autoResponseBody"):
        s["autoResponseBody"] = "Hi {{name}},\n\nThank you for your enquiry about {{product}}.\n\nWe will get back to you shortly.\n\nBest regards"

    if not isinstance(s.get("whatsappTemplates"), dict):
        s["whatsappTemplates"] = {}
    if not s["whatsappTemplates"].get("default"):
        s["whatsappTemplates"]["default"] = (
            "Hi {{name}},\n\nI am Natasha on behalf of Odd infotech and I got your enquiry in indiamart regarding {{product}}.\n\n"
            "Kindly please share more details about your requirements. Let me know the suitable time to talk to you."
        )

    return s

def save_settings_dict(s: dict):
    try:
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(s, f, indent=2)
    except Exception as e:
        print(f"Error saving settings to file: {e}")
