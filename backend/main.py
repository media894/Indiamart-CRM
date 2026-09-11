import os
import asyncio
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from backend.config import PORT, HOST, PUBLIC_DIR, ASSETS_DIR, BASE_DIR
from backend.database import connect_mongo, load_data, save_data
from backend.routes.leads import router as leads_router
from backend.routes.settings import router as settings_router
from backend.routes.email import router as email_router
from backend.routes.whatsapp import router as whatsapp_router
from backend.routes.webhooks import router as webhooks_router

from backend.services.indiamart_sync import execute_indiamart_sync
from backend.services.whatsapp_service import initialize_whatsapp, send_whatsapp_message
from backend.services.conversation_manager import get_due_followups

app = FastAPI(title="IndiaMART CRM API", version="1.0.0")

# Enable CORS for frontend client interactions
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API Routers
app.include_router(leads_router)
app.include_router(settings_router)
app.include_router(email_router)
app.include_router(whatsapp_router)
app.include_router(webhooks_router)

# Mount static asset folders
FRONTEND_DIR = BASE_DIR / "frontend"
STATIC_DIR = FRONTEND_DIR / "static"
TEMPLATES_DIR = FRONTEND_DIR / "templates"

STATIC_DIR.mkdir(parents=True, exist_ok=True)
TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")

# Serve SPA index.html on root route
@app.get("/")
async def serve_index():
    index_path = TEMPLATES_DIR / "index.html"
    if not index_path.exists():
        public_index = PUBLIC_DIR / "index.html"
        if public_index.exists():
            return FileResponse(str(public_index))
    return FileResponse(str(index_path))

# Background sync task runner for IndiaMART Leads
async def periodic_indiamart_sync():
    while True:
        try:
            print("[Background Worker] Executing periodic IndiaMART sync...")
            execute_indiamart_sync()
        except Exception as e:
            print(f"[Background Worker] Periodic sync note: {e}")
        await asyncio.sleep(300)

# Background worker for 7-Day Smart WhatsApp Follow-Ups
async def periodic_7day_followup_worker():
    while True:
        try:
            due_leads = get_due_followups()
            if due_leads:
                print(f"[7-Day Followup Worker] Found {len(due_leads)} leads requiring 7-day followup...")
                d = load_data()
                for lead in due_leads:
                    if not lead.get("replied") and lead.get("phone"):
                        name = lead.get("name", "there")
                        product = lead.get("product", "your enquiry")
                        msg = f"Hi {name}, following up on your enquiry regarding {product} with ODD INFOTECH. Let us know if you have any questions or if you'd like a customized quote!"
                        
                        try:
                            send_whatsapp_message(lead["phone"], msg)
                            print(f"[7-Day Followup Worker] Sent followup to {lead['phone']}")
                        except Exception as e:
                            print(f"[7-Day Followup Worker] Error sending to {lead['phone']}: {e}")

                        # Update lead status
                        idx = next((i for i, l in enumerate(d.get("leads", [])) if l["id"] == lead["id"]), -1)
                        if idx != -1:
                            d["leads"][idx]["followupStatus"] = "SENT_7DAY_FOLLOWUP"
                            d["leads"][idx]["updatedAt"] = datetime.utcnow().isoformat()
                save_data(d)
        except Exception as e:
            print(f"[7-Day Followup Worker] Error: {e}")

        # Check every 60 seconds
        await asyncio.sleep(60)

@app.on_event("startup")
async def startup_event():
    print(f"IndiaMART CRM Backend starting on http://{HOST}:{PORT}")
    connect_mongo()
    initialize_whatsapp()
    asyncio.create_task(periodic_indiamart_sync())
    asyncio.create_task(periodic_7day_followup_worker())
